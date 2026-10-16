import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "./jsonStore.js";

/**
 * `readFile` passa pelo disco de verdade, mas conta as chamadas e pode SEGURAR a próxima leitura
 * depois de ler — é assim que se reproduz um leitor lento que leu a versão velha do arquivo e só
 * devolve depois que uma mutação já gravou a nova.
 */
const fsHooks = vi.hoisted(() => ({ reads: 0, hold: null as Promise<void> | null, renames: 0, failRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    fsHooks.reads++;
    const hold = fsHooks.hold;
    fsHooks.hold = null;
    const out = await actual.readFile(...args);
    if (hold) await hold;
    return out;
  };
  // Every persist ends in a rename: counting them counts the writes that reached the file, and
  // failing one is a write the disk refused (full disk) at the last step.
  const rename = async (...args: Parameters<typeof actual.rename>) => {
    fsHooks.renames++;
    if (fsHooks.failRename) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return await actual.rename(...args);
  };
  // Cast: readFile is overloaded and the wrapper only re-exposes its last overload.
  return { ...actual, readFile: readFile as typeof actual.readFile, rename };
});

interface Doc { items: string[] }

let dir = "";
let file = "";
let store: JsonStore<Doc>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-store-"));
  file = join(dir, "nested", "doc.json");
  store = new JsonStore<Doc>(file, () => ({ items: [] }));
  fsHooks.reads = 0;
  fsHooks.hold = null;
  fsHooks.renames = 0;
  fsHooks.failRename = false;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonStore", () => {
  it("seeds when the file does not exist", async () => {
    expect(await store.load()).toEqual({ items: [] });
  });

  it("persists atomically with mode 600 and creates parent dirs", async () => {
    await store.mutate((d) => d.items.push("a"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["a"] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent mutations — no lost update", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.mutate((d) => d.items.push(`i${i}`))));
    const doc = JSON.parse(await readFile(file, "utf8")) as Doc;
    expect(doc.items).toHaveLength(25);
  });

  it("keeps the queue alive after a failing mutation", async () => {
    await expect(store.mutate(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await store.mutate((d) => d.items.push("after"));
    expect((await store.load()).items).toEqual(["after"]);
  });

  it("normalizes documents read from disk", async () => {
    await store.mutate((d) => d.items.push("x"));
    const reopened = new JsonStore<Doc>(file, () => ({ items: [] }), (raw) => ({
      items: (raw as Doc).items ?? [],
    }));
    expect((await reopened.load()).items).toEqual(["x"]);
  });

  it("a mutation that fails to persist is not served nor written by the next one", async () => {
    await store.mutate((d) => d.items.push("a"));
    fsHooks.failRename = true;
    await expect(store.mutate((d) => d.items.push("lost"))).rejects.toThrow("ENOSPC");
    expect((await store.load()).items).toEqual(["a"]);

    fsHooks.failRename = false;
    await store.mutate((d) => d.items.push("b"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["a", "b"] });
  });

  it("a mutation that throws halfway leaves no partial change behind", async () => {
    await store.mutate((d) => d.items.push("a"));
    await expect(store.mutate((d) => { d.items.push("half"); throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await store.load()).items).toEqual(["a"]);
  });

  it("a refusal BEFORE any change (a validation error) keeps the cache — no disk read per refusal", async () => {
    await store.mutate((d) => d.items.push("a"));
    const live = await store.load();
    fsHooks.reads = 0;
    for (let i = 0; i < 3; i += 1) {
      await expect(store.mutate(() => { throw new Error("already exists"); })).rejects.toThrow("already exists");
    }
    expect(await store.load()).toBe(live); // the same live document callers already hold
    expect(fsHooks.reads).toBe(0);
  });

  it("a slow cold reader cannot put the old document back after a mutation", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(file, JSON.stringify({ items: ["old"] }), "utf8");
    fsHooks.reads = 0;
    let release = (): void => undefined;
    fsHooks.hold = new Promise<void>((resolve) => { release = resolve; });

    const reader = store.load(); // reads ["old"], then stalls
    const mutation = store.mutate((d) => d.items.push("m"));
    // Gives the mutation every chance to finish while the reader is stalled. With a second,
    // independent disk read it does, and the stale reader then overwrites the cache with ["old"];
    // sharing the one in-flight read, it simply waits for the reader (and the timeout wins).
    await Promise.race([mutation, new Promise((resolve) => setTimeout(resolve, 200))]);
    release();
    await Promise.all([reader, mutation]);

    await store.mutate((d) => d.items.push("n"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["old", "m", "n"] });
    expect(fsHooks.reads).toBe(2); // the one shared cold load + the assertion above
  });

  it("a mutation that changes nothing does not rewrite the file", async () => {
    await store.mutate((d) => d.items.push("a"));
    fsHooks.renames = 0;
    await store.mutate(() => undefined);
    await store.mutate((d) => { if (!d.items.includes("a")) d.items.push("a"); });
    expect(fsHooks.renames).toBe(0);
  });

  it("a no-op mutation still creates a file that does not exist yet", async () => {
    await store.mutate(() => undefined);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: [] });
  });
});

/**
 * O DEPLOY BLUE/GREEN: o back novo e o antigo convivem alguns segundos sobre o MESMO /data. A fila
 * de mutações só serializa dentro de um processo — aqui, dois JsonStore no mesmo arquivo fazem o
 * papel dos dois processos.
 */
describe("JsonStore — dois processos no mesmo arquivo", () => {
  it("a mutação de um não apaga o que o outro gravou depois que ele leu", async () => {
    const other = new JsonStore<Doc>(file, () => ({ items: [] }));
    await store.load(); // o back novo sobe e lê o arquivo
    await other.mutate((d) => d.items.push("antigo")); // o back antigo, ainda vivo, grava
    await store.mutate((d) => d.items.push("novo"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["antigo", "novo"] });
  });

  it("o arquivo temporário de um não atrapalha a gravação do outro", async () => {
    await store.mutate((d) => d.items.push("a"));
    // O tmp do outro processo, no meio da escrita dele, ocupando o caminho (um diretório basta
    // para o open/rename de um tmp de nome FIXO falhar).
    await mkdir(`${file}.tmp`);
    await store.mutate((d) => d.items.push("b"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["a", "b"] });
  });
});

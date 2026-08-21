import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "./jsonStore.js";

interface Doc { items: string[] }

let dir = "";
let store: JsonStore<Doc>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-store-"));
  store = new JsonStore<Doc>(join(dir, "nested", "doc.json"), () => ({ items: [] }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonStore", () => {
  it("seeds when the file does not exist", async () => {
    expect(await store.load()).toEqual({ items: [] });
  });

  it("persists atomically with mode 600 and creates parent dirs", async () => {
    await store.mutate((d) => d.items.push("a"));
    const file = join(dir, "nested", "doc.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ items: ["a"] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent mutations — no lost update", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.mutate((d) => d.items.push(`i${i}`))));
    const doc = JSON.parse(await readFile(join(dir, "nested", "doc.json"), "utf8")) as Doc;
    expect(doc.items).toHaveLength(25);
  });

  it("keeps the queue alive after a failing mutation", async () => {
    await expect(store.mutate(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await store.mutate((d) => d.items.push("after"));
    expect((await store.load()).items).toEqual(["after"]);
  });

  it("normalizes documents read from disk", async () => {
    await store.mutate((d) => d.items.push("x"));
    const reopened = new JsonStore<Doc>(join(dir, "nested", "doc.json"), () => ({ items: [] }), (raw) => ({
      items: (raw as Doc).items ?? [],
    }));
    expect((await reopened.load()).items).toEqual(["x"]);
  });
});

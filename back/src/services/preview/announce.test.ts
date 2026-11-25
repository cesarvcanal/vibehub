import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewPublicUrl, portNotListeningError, PREVIEW_BASE_HINT } from "./announce.js";
import { CWD_MARKER, PROC_MARKER } from "./preview.js";
import type { PreviewProbe } from "./probe.js";

/**
 * `vibehub_preview`'s engine: the pure URL/error builders, and announcePreview end to end against
 * a fresh registry with the runner scan mocked (same module-reset pattern as the registry tests —
 * the scan itself is unit-tested in preview.test.ts).
 */

let dir = "";
const runScript = vi.fn();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-announce-"));
  runScript.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** /proc/net/tcp rows for the given LISTENING ports (state 0A, inode 1). */
function scanOutput(ports: number[]): string {
  const rows = ports.map(
    (p, i) =>
      `${i}: 0100007F:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 0:0 0:0 0 0 1 1`,
  );
  return `sl local rem st tq tr re uid to inode\n${rows.join("\n")}\n${PROC_MARKER}\n`;
}

/**
 * `probe` is what the end-to-end page check saw (null = it could not run, the pre-existing
 * behaviour: announce on LISTENING alone). The probe's own I/O is tested in probe.test.ts against a
 * real upstream; here it is injected so the ANNOUNCEMENT's reaction to it is what gets tested.
 */
async function boot(probe: PreviewProbe | null = null) {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.publicUrl = "http://192.0.2.10:3010/";
  vi.doMock("../../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../../runtime/host.js")>("../../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript }) };
  });
  vi.doMock("./probe.js", async () => {
    const actual = await vi.importActual<typeof import("./probe.js")>("./probe.js");
    return { ...actual, probePreview: async () => probe };
  });
  const registry = await import("../board/registry.js");
  const announce = await import("./announce.js");
  const project = await registry.createProject({ name: "Shop" });
  const card = await registry.createCard({ projectId: project.id, title: "Checkout" });
  return { registry, announce, cardId: card.id };
}

describe("previewPublicUrl (pure)", () => {
  it("joins publicUrl and the proxy path, tolerating trailing slashes", () => {
    expect(previewPublicUrl("http://192.0.2.10:3010", 5173)).toBe("http://192.0.2.10:3010/preview/5173/");
    expect(previewPublicUrl("http://vibehub.multi/", 3000)).toBe("http://vibehub.multi/preview/3000/");
  });

  it("refuses a port that could not be proxied", () => {
    expect(() => previewPublicUrl("http://x", 0)).toThrow(/invalid preview port/);
  });
});

describe("portNotListeningError (pure)", () => {
  it("names what IS listening so the agent can act", () => {
    const err = portNotListeningError(5173, [{ port: 3000, address: "all", process: "node" }]);
    expect(err.message).toMatch(/nothing is listening on port 5173/);
    expect(err.message).toMatch(/3000 \(node\)/);
  });

  it("says when nothing at all is listening", () => {
    expect(portNotListeningError(5173, []).message).toMatch(/Nothing is listening at all/);
  });
});

describe("announcePreview", () => {
  it("verifica a porta, registra o preview e devolve só o caminho, sem endereço de um host que o usuário pode não usar", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    const out = await announce.announcePreview(cardId, 5173, { label: "  front  " });
    expect(out).toEqual({
      registered: true,
      cardId,
      port: 5173,
      label: "front",
      path: "/preview/5173/",
      hint: PREVIEW_BASE_HINT,
    });
    const card = await registry.getCard(cardId);
    expect(card?.previews).toEqual([{ port: 5173, label: "front", createdAt: expect.any(Number) }]);
  });

  it("stores the relaunch recipe: command as announced, cwd defaulting to the card's worktree", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    await announce.announcePreview(cardId, 5173, { label: "front", command: "npm run dev -- --port 5173" });
    const preview = (await registry.getCard(cardId))?.previews?.[0];
    expect(preview?.command).toBe("npm run dev -- --port 5173");
    // A project with no repository puts the card in the scratch directory — that is its cwd.
    expect(preview?.cwd).toMatch(/^\/work\/scratch\//);

    // An explicit cwd wins; a malformed one is refused before anything is scanned or written.
    await announce.announcePreview(cardId, 5173, { command: "npm start", cwd: "/work/app" });
    expect((await registry.getCard(cardId))?.previews?.[0]?.cwd).toBe("/work/app");
    await expect(
      announce.announcePreview(cardId, 5173, { command: "npm start", cwd: "../etc" }),
    ).rejects.toThrow(/invalid preview cwd/);
    await expect(
      announce.announcePreview(cardId, 5173, { command: "a\nb" }),
    ).rejects.toThrow(/single line/);
  });

  it("recusa a porta servida por um processo de outra pasta, sem registrar nada", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({
      stdout: `${scanOutput([8765])}1 40 python3\n${CWD_MARKER}\n/proc/40 /tmp/artefato-processos\n`,
      stderr: "",
      code: 0,
    });

    await expect(
      announce.announcePreview(cardId, 8765, { command: "python3 -m http.server 8765", cwd: "/work/app/prototipos" }),
    ).rejects.toThrow(/port 8765 is served by python3 running in \/tmp\/artefato-processos, not in \/work\/app\/prototipos/);
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
  });

  it.each(["/work/app", "/work/app/front"])("aceita o servidor que roda na pasta anunciada ou dentro dela: %s", async (listenerCwd) => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: `${scanOutput([5173])}1 40 node\n${CWD_MARKER}\n/proc/40 ${listenerCwd}\n`, stderr: "", code: 0 });

    await announce.announcePreview(cardId, 5173, { command: "npm run dev", cwd: "/work/app" });
    expect((await registry.getCard(cardId))?.previews).toHaveLength(1);
  });

  it("não confunde pasta irmã com prefixo parecido com a pasta anunciada", async () => {
    const { announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: `${scanOutput([5173])}1 40 node\n${CWD_MARKER}\n/proc/40 /work/app-old\n`, stderr: "", code: 0 });

    await expect(announce.announcePreview(cardId, 5173, { command: "npm run dev", cwd: "/work/app" })).rejects.toThrow(
      /served by node running in \/work\/app-old/,
    );
  });

  it("refuses a silent port WITHOUT registering anything", async () => {
    const { registry, announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([3000]), stderr: "", code: 0 });

    await expect(announce.announcePreview(cardId, 5173)).rejects.toThrow(/nothing is listening on port 5173/);
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
  });

  it("REFUSES a page that loops on its own prefix — LISTENING was never proof it opens", async () => {
    // The bug this check exists for: a vite based at /preview/<port>/ answers the stripped "/" with
    // a 302 back to the prefix, the port is up the whole time, and the user finds the dead tab.
    const { registry, announce, cardId } = await boot({
      status: 302,
      loop: true,
      location: "/preview/5173/",
      body: "",
    });
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    await expect(announce.announcePreview(cardId, 5173)).rejects.toThrow(/loop de redirect/);
    expect((await registry.getCard(cardId))?.previews).toBeUndefined();
  });

  it("announces a page that opens but is visibly wrong, carrying the warning to the user", async () => {
    const { registry, announce, cardId } = await boot({
      status: 200,
      loop: false,
      contentType: "text/html",
      body: '<script type="module" src="/src/main.tsx"></script>',
    });
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });

    const out = await announce.announcePreview(cardId, 5173);
    expect(out.warning).toMatch(/assets absolutos/);
    expect(out.warning).toContain("/src/main.tsx");
    // A warning is not a refusal: the chip exists and the link works, partially.
    expect((await registry.getCard(cardId))?.previews).toHaveLength(1);
  });

  it("unknown card and invalid port fail with actionable errors (no scan for the bad port)", async () => {
    const { announce, cardId } = await boot();
    runScript.mockResolvedValue({ stdout: scanOutput([5173]), stderr: "", code: 0 });
    await expect(announce.announcePreview("nope", 5173)).rejects.toThrow(/VIBEHUB_CARD_ID/);
    await expect(announce.announcePreview(cardId, 70000)).rejects.toThrow(/invalid preview port/);
  });
});

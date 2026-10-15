import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * O catálogo de modelos: o nome com versão de cada alias vem da CLI do runner, nunca de uma lista
 * escrita à mão. INVARIANTES:
 *  - os ids são SEMPRE os da whitelist — a CLI só dá nome a eles;
 *  - sem resposta da CLI, o menu volta aos nomes de família (nunca vazio, nunca lança);
 *  - uma versão nova (Opus 5.6) aparece sem mudar código;
 *  - a CLI é consultada uma vez por TTL, e uma falha não vira uma consulta por abertura de menu.
 *
 * O host executor é mockado; o disco é um data dir temporário.
 */

const runScript = vi.fn();
vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: () => ({ kind: "local", label: "this machine", runScript, ptyCommand: vi.fn(), writeFile: vi.fn() }),
}));

const PROBE_ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5" },
  { value: "opus", resolvedModel: "claude-opus-5-5" },
  { value: "fable", resolvedModel: "claude-fable-5-1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5" },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001" },
];
const probeOut = (rows: unknown) => `noise\nVIBEHUB_MODELS_JSON:${JSON.stringify(rows)}\n`;

let dir = "";
let probeStdout = "";

async function fresh() {
  vi.resetModules();
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-master-key";
  return await import("./models.js");
}

const probeCalls = () => runScript.mock.calls.filter(([s]) => String(s).includes("VIBEHUB_MODELS_PROBE"));

beforeEach(async () => {
  vi.clearAllMocks();
  probeStdout = probeOut(PROBE_ROWS);
  runScript.mockImplementation(async (script: string) =>
    script.includes("VIBEHUB_MODELS_PROBE") ? { stdout: probeStdout, stderr: "" } : { stdout: "", stderr: "" },
  );
  dir = await mkdtemp(join(tmpdir(), "vibehub-models-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseModelProbe", () => {
  it("names each whitelisted alias with the version the CLI resolves it to", async () => {
    const mod = await fresh();
    expect(mod.parseModelProbe(probeOut(PROBE_ROWS))).toEqual([
      { id: "fable", label: "Fable 5.1", resolved: "claude-fable-5-1" },
      { id: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5" },
      { id: "sonnet", label: "Sonnet 5.5", resolved: "claude-sonnet-5-5" },
      { id: "haiku", label: "Haiku 5.5", resolved: "claude-haiku-5-5" },
    ]);
  });

  it("picks up a release nobody wrote down — Opus 5.6 needs no code change", async () => {
    const mod = await fresh();
    const rows = [{ value: "opus", resolvedModel: "claude-opus-5-6" }, ...PROBE_ROWS];
    expect(mod.parseModelProbe(probeOut(rows))?.find((m) => m.id === "opus")?.label).toBe("Opus 5.6");
  });

  it("keeps a family the CLI did not list, by its family name", async () => {
    const mod = await fresh();
    const parsed = mod.parseModelProbe(probeOut([{ value: "opus", resolvedModel: "claude-opus-5-5" }]));
    expect(parsed?.map((m) => m.label)).toEqual(["Fable", "Opus 5.5", "Sonnet", "Haiku"]);
  });

  it("never lets a model outside the whitelist in, and ignores a date stamp", async () => {
    const mod = await fresh();
    const parsed = mod.parseModelProbe(
      probeOut([{ value: "$(rm -rf /)", resolvedModel: "claude-evil-9" }, { value: "claude-haiku-4-5-20251001" }]),
    );
    expect(parsed?.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(parsed?.find((m) => m.id === "haiku")?.label).toBe("Haiku 4.5");
  });

  it("returns null for output it cannot read", async () => {
    const mod = await fresh();
    expect(mod.parseModelProbe("")).toBeNull();
    expect(mod.parseModelProbe("VIBEHUB_MODELS_JSON:{not json")).toBeNull();
    expect(mod.parseModelProbe("VIBEHUB_MODELS_JSON:{}")).toBeNull();
    expect(mod.parseModelProbe(probeOut([{ value: "gpt-5" }]))).toBeNull();
  });
});

describe("buildModelProbeScript", () => {
  it("asks the runner's SDK with the profile token, never an API key, in a quoted heredoc", async () => {
    const mod = await fresh();
    const script = mod.buildModelProbeScript("vibehub-runner");
    expect(script).toMatch(/^docker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_MODELS_PROBE'\n/);
    expect(script).toContain("unset ANTHROPIC_API_KEY");
    expect(script).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(script).toContain("/root/.vibehub-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
    expect(script).toContain("supportedModels()");
    expect(script.trimEnd().endsWith("\nVIBEHUB_MODELS_PROBE")).toBe(true);
  });
});

describe("getModelCatalog", () => {
  it("waits for the CLI the first time, then answers from memory without asking again", async () => {
    const mod = await fresh();
    const first = await mod.getModelCatalog();
    expect(first.models.find((m) => m.id === "opus")?.label).toBe("Opus 5.5");
    expect(first.at).toBeGreaterThan(0);
    await mod.getModelCatalog();
    expect(probeCalls()).toHaveLength(1);
  });

  it("menus opened together share ONE probe", async () => {
    const mod = await fresh();
    await Promise.all([mod.getModelCatalog(), mod.getModelCatalog(), mod.getModelCatalog()]);
    expect(probeCalls()).toHaveLength(1);
  });

  it("falls back to family names when the CLI fails, and does not retry on every menu", async () => {
    const mod = await fresh();
    runScript.mockRejectedValue(new Error("runner down"));
    const catalog = await mod.getModelCatalog();
    expect(catalog).toEqual(mod.fallbackCatalog());
    expect(catalog.models.map((m) => m.label)).toEqual(["Fable", "Opus", "Sonnet", "Haiku"]);
    const calls = runScript.mock.calls.length;
    await mod.getModelCatalog();
    expect(runScript.mock.calls.length).toBe(calls);
    // Passada a janela de nova tentativa, a CLI é consultada outra vez.
    runScript.mockImplementation(async (s: string) =>
      s.includes("VIBEHUB_MODELS_PROBE") ? { stdout: probeStdout, stderr: "" } : { stdout: "", stderr: "" },
    );
    const later = await mod.getModelCatalog(Date.now() + mod.MODEL_CATALOG_RETRY_MS + 1);
    expect(later.models.find((m) => m.id === "opus")?.label).toBe("Opus 5.5");
  });

  it("survives a restart from disk, and refreshes a stale one in the background", async () => {
    const mod = await fresh();
    await mod.getModelCatalog();
    const onDisk = JSON.parse(await readFile(join(dir, mod.MODEL_CATALOG_FILE), "utf8"));
    expect(onDisk.models.find((m: { id: string }) => m.id === "opus").label).toBe("Opus 5.5");

    // Um catálogo velho no disco responde na hora; a renovação traz a versão nova.
    await writeFile(join(dir, mod.MODEL_CATALOG_FILE), JSON.stringify({ ...onDisk, at: 1 }), "utf8");
    const restarted = await fresh();
    probeStdout = probeOut([{ value: "opus", resolvedModel: "claude-opus-5-6" }, ...PROBE_ROWS]);
    runScript.mockClear();
    const stale = await restarted.getModelCatalog();
    expect(stale.models.find((m) => m.id === "opus")?.label).toBe("Opus 5.5");
    await vi.waitFor(() => expect(probeCalls()).toHaveLength(1));
    await vi.waitFor(async () =>
      expect((await restarted.getModelCatalog()).models.find((m) => m.id === "opus")?.label).toBe("Opus 5.6"),
    );
  });

  it("treats a catalog from another SDK version as stale", async () => {
    const mod = await fresh();
    const old = { models: [{ id: "opus", label: "Opus 5" }], at: Date.now(), sdkVersion: "0.0.1" };
    await writeFile(join(dir, mod.MODEL_CATALOG_FILE), JSON.stringify(old), "utf8");
    await mod.getModelCatalog();
    await vi.waitFor(() => expect(probeCalls()).toHaveLength(1));
  });
});

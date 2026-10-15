import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { config, dataPath } from "../../config/env.js";
import { CLAUDE_MODELS, type ClaudeModelId } from "../board/registry.js";
import { DEFAULT_CLAUDE_DIR, oauthTokenPath } from "../accounts/profiles.js";
import { modelLabelFor } from "../maestro/maestro.js";
import { SDK_DRIVER_DIR, SDK_PACKAGE_VERSION, installCardSdkDriver } from "./driver.js";
import { logger } from "../../utils/logger.js";

/**
 * O CATÁLOGO DE MODELOS — qual versão cada alias de família resolve HOJE ("opus" → Opus 5.5).
 *
 * O card fixa só a família (`claude --model opus`) e a CLI escolhe a versão mais nova que conhece.
 * Isso já fazia um Opus novo chegar sozinho a todo card; o que faltava era o MENU dizer qual é: ele
 * mostrava "Opus" e parecia travado numa versão velha. Quem sabe a resposta é a própria CLI — o
 * `supportedModels()` do Agent SDK devolve, por alias, o `resolvedModel` (`claude-opus-5-5`). Então
 * a lista não é escrita aqui: um Opus 5.6 aparece no menu assim que a CLI do runner o conhecer.
 *
 * A pergunta vai para o MESMO SDK que o driver do card roda (SDK_PACKAGE_VERSION), não para o
 * `@latest`: o menu tem que dizer o que o card VAI rodar, e não o que existe no npm.
 *
 * Os ids continuam sendo os da whitelist (`CLAUDE_MODELS`): o catálogo só dá NOME a eles. Nada que
 * vem da CLI chega a uma linha de comando.
 *
 * Nada aqui lança: sem catálogo o menu volta aos nomes de família, como sempre foi.
 */

export interface ModelCatalogEntry {
  /** O alias que o card fixa — sempre um da whitelist. */
  id: ClaudeModelId;
  /** Nome com versão ("Opus 5.5"), ou só a família quando a CLI não disse a versão. */
  label: string;
  /** Id que o alias resolve hoje (`claude-opus-5-5`), quando conhecido. */
  resolved?: string;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  /** Quando a CLI respondeu (epoch ms); 0 = nunca respondeu, os nomes são os de família. */
  at: number;
  /** Versão do SDK que respondeu — trocar o SDK invalida o catálogo. */
  sdkVersion?: string;
}

/** Os nomes mudam quando sai um modelo novo, não de minuto em minuto. */
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** Uma consulta que falhou não é repetida a cada abertura de menu. */
export const MODEL_CATALOG_RETRY_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;

export const MODEL_CATALOG_FILE = "sdk-models.json";
const PROBE_MARKER = "VIBEHUB_MODELS_JSON:";
const PROBE_DELIM = "VIBEHUB_MODELS_PROBE";

function familyLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** O catálogo sem a CLI: só os nomes de família. PURE. */
export function fallbackCatalog(): ModelCatalog {
  return { models: CLAUDE_MODELS.map((id) => ({ id, label: familyLabel(id) })), at: 0 };
}

const RESOLVED_RE = new RegExp(`^claude-(${CLAUDE_MODELS.join("|")})-\\d`);

/**
 * Lê a saída do probe: a linha marcada traz o JSON do `supportedModels()`. Cada família da
 * whitelist pega o PRIMEIRO `resolvedModel` daquela família (a linha do alias vem antes das
 * variantes); família que a CLI não listou fica com o nome sem versão. `null` = saída ilegível. PURE.
 */
export function parseModelProbe(stdout: string): ModelCatalogEntry[] | null {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(PROBE_MARKER));
  if (!line) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(line.slice(PROBE_MARKER.length));
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const resolvedBy = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { value, resolvedModel } = row as { value?: unknown; resolvedModel?: unknown };
    const resolved = typeof resolvedModel === "string" ? resolvedModel : typeof value === "string" ? value : "";
    const family = RESOLVED_RE.exec(resolved.toLowerCase())?.[1];
    if (family && !resolvedBy.has(family)) resolvedBy.set(family, resolved.toLowerCase());
  }
  if (resolvedBy.size === 0) return null;
  return CLAUDE_MODELS.map((id) => {
    const resolved = resolvedBy.get(id);
    return resolved ? { id, label: modelLabelFor(resolved) ?? familyLabel(id), resolved } : { id, label: familyLabel(id) };
  });
}

/**
 * Script que pergunta à CLI do runner os modelos que ela conhece, com a conta padrão (o token do
 * perfil, nunca API key — mesma regra do driver), num cwd neutro e sem nenhum turno. PURE.
 */
export function buildModelProbeScript(containerName: string): string {
  const sdk = `${SDK_DRIVER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`;
  const js = [
    `import { query } from ${JSON.stringify(sdk)};`,
    `setTimeout(() => process.exit(2), ${PROBE_TIMEOUT_MS - 5_000}).unref();`,
    "async function* idle() { await new Promise(() => {}); }",
    "const q = query({ prompt: idle(), options: { settingSources: [] } });",
    "const rows = await q.supportedModels();",
    `process.stdout.write(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(rows.map((r) => ({ value: r.value, resolvedModel: r.resolvedModel }))) + "\\n");`,
    "process.exit(0);",
  ].join("\n");
  const tokenFile = oauthTokenPath(DEFAULT_CLAUDE_DIR);
  const inner = [
    "unset ANTHROPIC_API_KEY",
    "export IS_SANDBOX=1",
    `if [ -s ${shQuote(tokenFile)} ]; then export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shQuote(tokenFile)})"; fi`,
    "cd /tmp",
    `node --input-type=module -e ${shQuote(js)}`,
  ].join("\n");
  return [`docker exec -i ${shQuote(containerName)} bash -s <<'${PROBE_DELIM}'`, inner, PROBE_DELIM].join("\n");
}

let cached: ModelCatalog | null = null;
let loadedFromDisk = false;
let lastFailureAt = 0;
let inFlight: Promise<ModelCatalog | null> | null = null;

async function readDisk(): Promise<ModelCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(dataPath(MODEL_CATALOG_FILE), "utf8")) as ModelCatalog;
    if (!parsed || !Array.isArray(parsed.models) || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDisk(catalog: ModelCatalog): Promise<void> {
  try {
    const file = dataPath(MODEL_CATALOG_FILE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(catalog), "utf8");
  } catch {
    /* sem durabilidade: o catálogo em memória ainda serve até o próximo restart */
  }
}

/** Uma consulta à CLI por vez — os menus que abrem juntos esperam a mesma resposta. */
function refresh(): Promise<ModelCatalog | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await installCardSdkDriver();
      const { stdout } = await hostExecutor().runScript(buildModelProbeScript(config.runner.container), {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      const models = parseModelProbe(stdout);
      if (!models) throw new Error("model probe returned nothing usable");
      cached = { models, at: Date.now(), sdkVersion: SDK_PACKAGE_VERSION };
      await writeDisk(cached);
      return cached;
    } catch (err) {
      lastFailureAt = Date.now();
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "model catalog unavailable");
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function isFresh(catalog: ModelCatalog, now: number): boolean {
  return catalog.sdkVersion === SDK_PACKAGE_VERSION && now - catalog.at < MODEL_CATALOG_TTL_MS;
}

/**
 * O catálogo para o menu. Responde na hora com o que já sabe (memória, depois disco) e, se aquilo
 * está velho, renova em segundo plano. Só ESPERA a CLI quando não sabe nada ainda — a primeira
 * abertura depois da instalação. Nunca lança: no pior caso, os nomes de família.
 */
export async function getModelCatalog(now: number = Date.now()): Promise<ModelCatalog> {
  if (!cached && !loadedFromDisk) {
    loadedFromDisk = true;
    cached = await readDisk();
  }
  const canRetry = now - lastFailureAt >= MODEL_CATALOG_RETRY_MS;
  if (cached) {
    if (!isFresh(cached, now) && canRetry) void refresh();
    return cached;
  }
  if (!canRetry) return fallbackCatalog();
  return (await refresh()) ?? fallbackCatalog();
}

/** Só para os testes: esquece o que o módulo aprendeu. */
export function resetModelCatalogForTests(): void {
  cached = null;
  loadedFromDisk = false;
  lastFailureAt = 0;
  inFlight = null;
}

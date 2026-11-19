import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: import.meta.dirname });

async function ruleIdsOf(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId ?? message.message);
}

describe("eslint.config.js: regras do AGENTS.md em todo .ts, .tsx e .mjs do repositório", () => {
  it.each([
    ["let (§3)", "let count = 0;\ncount += 1;\nexport { count };", "no-restricted-syntax"],
    ["var (§3)", "var count = 0;\nexport { count };", "no-var"],
    ["import não usado (§1.5)", 'import { readFile } from "node:fs/promises";\nexport const ready = true;', "@typescript-eslint/no-unused-vars"],
    ["any explícito (§5.5)", "export const parse = (raw: any) => raw;", "@typescript-eslint/no-explicit-any"],
    ["catch vazio (§9)", "export function read(run: () => void) {\n  try {\n    run();\n  } catch {}\n}", "no-restricted-syntax"],
    ["catch vazio com comentário de marcador (§9)", "export function read(run: () => void) {\n  try {\n    run();\n  } catch {\n    // limitation: sandbox may refuse\n  }\n}", "no-restricted-syntax"],
    [".catch(() => {}) (§9)", "export const fire = (job: Promise<void>) => job.catch(() => {});", "no-restricted-syntax"],
    [".catch(() => {}) atribuído a outra coisa que a fila (§9)", "export function track(state: { pending: Promise<void> }, job: Promise<void>) {\n  state.pending = job.catch(() => {});\n}", "no-restricted-syntax"],
    [".catch(() => {}) atribuído a variável que não é a fila (§9)", "export function track(job: Promise<void>, pending: Promise<void>) {\n  pending = job.catch(() => {});\n  return pending;\n}", "no-restricted-syntax"],
    [".catch(() => {}) atribuído a campo de this que não é a fila (§9)", "export class Tracker {\n  pending?: Promise<void>;\n  track(job: Promise<void>) {\n    this.pending = job.catch(() => {});\n  }\n}", "no-restricted-syntax"],
    ["void job.catch(() => {}).then(run) (§9)", "export function fire(job: Promise<void>, run: () => void) {\n  void job.catch(() => {}).then(run);\n}", "no-restricted-syntax"],
    ["job.catch(() => {}).then(run) solto (§9)", "export function fire(job: Promise<void>, run: () => void) {\n  job.catch(() => {}).then(run);\n}", "no-restricted-syntax"],
    [".catch(function () {}) (§9)", "export const fire = (job: Promise<void>) => job.catch(function () {});", "no-restricted-syntax"],
    [".catch(() => null) (§9)", "export const fire = (job: Promise<void>) => job.catch(() => null);", "no-restricted-syntax"],
    [".catch(() => void 0) (§9)", "export const fire = (job: Promise<void>) => job.catch(() => void 0);", "no-restricted-syntax"],
    [".catch(() => undefined) (§9)", "export async function fire(job: Promise<void>) {\n  await job.catch(() => undefined);\n}", "no-restricted-syntax"],
    ["@ts-expect-error sem o motivo (§3)", "// @ts-expect-error\nexport const value: number = 'text';", "@typescript-eslint/ban-ts-comment"],
    ["@ts-ignore (§3)", "// @ts-ignore\nexport const value: number = 'text';", "@typescript-eslint/ban-ts-comment"],
    ["comentário sem marcador (§3)", "// only live cards\nexport const ready = true;", "vibehub/no-unmarked-comment"],
  ])("reprova %s no código de produção", async (_case, code, ruleId) => {
    expect(await ruleIdsOf(code, "back/src/services/example.ts")).toContain(ruleId);
  });

  it.each([
    ["front/src/features/board/Example.tsx", "export const Example = () => <div>{([] as any[]).length}</div>;"],
    ["back/src/services/example.test.ts", "export const parse = (raw: any) => raw;"],
  ])("vale em .tsx do front e em teste: %s", async (filePath, code) => {
    expect(await ruleIdsOf(code, filePath)).toContain("@typescript-eslint/no-explicit-any");
  });

  it.each([
    ["fila por card: queue = next.catch(() => undefined)", "// eslint-disable-next-line no-restricted-syntax -- live state of the queue\nlet queue = Promise.resolve();\nexport function enqueue(run: () => Promise<void>) {\n  const next = queue.then(run);\n  queue = next.catch(() => undefined);\n  return next;\n}"],
    ["fila no campo da classe: this.queue = next.catch(() => undefined)", "export class Store {\n  private queue: Promise<void> = Promise.resolve();\n  enqueue(run: () => Promise<void>) {\n    const next = this.queue.then(run);\n    this.queue = next.catch(() => undefined);\n    return next;\n  }\n}"],
    ["fila encadeada: previous.catch(() => undefined).then(run)", "export const chain = (previous: Promise<void>, run: () => Promise<void>) => previous.catch(() => undefined).then(run);"],
    ["fila encadeada guardada: const next = previous.catch(() => undefined).then(run)", "export function enqueue(previous: Promise<void>, run: () => Promise<void>) {\n  const next = previous.catch(() => undefined).then(run);\n  return next;\n}"],
    ["catch que trata o erro", "export const fire = (job: Promise<void>, warn: (error: unknown) => void) => job.catch((error) => warn(error));"],
    ["const", "export const count = 0;"],
    ["estado vivo com eslint-disable e motivo", "// eslint-disable-next-line no-restricted-syntax -- live state of the driver\nlet current = 0;\nexport const bump = () => (current += 1);"],
    ["catch vazio de melhor esforço com a diretiva e o motivo", "export function read(run: () => void) {\n  try {\n    run();\n    // eslint-disable-next-line no-restricted-syntax -- best effort: the next attach resends it\n  } catch {}\n}"],
    ["comentário com marcador", "// external: Docker exits 125 when the daemon refuses the run\nexport const DOCKER_REFUSED = 125;"],
  ])("aceita %s", async (_case, code) => {
    expect(await ruleIdsOf(code, "back/src/services/example.ts")).toEqual([]);
  });
});

describe("eslint.config.js: regras só de teste (§11)", () => {
  const testFile = "back/src/services/example.test.ts";

  it.each([
    ["afterEach que esvazia array de cleanup (use onTestFinished)", 'import { afterEach } from "vitest";\nconst cleanups: Array<() => Promise<void>> = [];\nafterEach(async () => {\n  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();\n});\nexport { cleanups };'],
    ["afterEach que zera o array de cleanup", 'import { afterEach } from "vitest";\nconst cleanups: Array<() => void> = [];\nafterEach(() => {\n  cleanups.forEach((cleanup) => cleanup());\n  cleanups.length = 0;\n});\nexport { cleanups };'],
    ["waitFor feito à mão (use vi.waitFor)", "export async function waitFor(check: () => Promise<boolean>) {\n  while (!(await check())) await new Promise((wake) => setTimeout(wake, 50));\n}"],
    ["waitFor à mão em arrow", "export const waitForPort = async (check: () => boolean) => {\n  while (!check()) await new Promise((wake) => setTimeout(wake, 50));\n};"],
    ["exists sobre fs.access (use existsSync)", 'import { access } from "node:fs/promises";\nexport function exists(path: string) {\n  return access(path).then(() => true, () => false);\n}'],
  ])("reprova %s", async (_case, code) => {
    expect(await ruleIdsOf(code, testFile)).toContain("no-restricted-syntax");
  });

  it.each([
    ["onTestFinished", 'import { it, onTestFinished } from "vitest";\nimport { rm } from "node:fs/promises";\nit("limpa", () => {\n  onTestFinished(() => rm("/tmp/x", { recursive: true, force: true }));\n});'],
    ["vi.waitFor", 'import { it, expect, vi } from "vitest";\nit("espera", async () => {\n  await vi.waitFor(() => expect(1).toBe(1));\n});'],
    ["afterEach que restaura mocks", 'import { afterEach, vi } from "vitest";\nafterEach(() => {\n  vi.restoreAllMocks();\n});'],
  ])("aceita %s", async (_case, code) => {
    expect(await ruleIdsOf(code, testFile)).toEqual([]);
  });

  it.each(["back/src/testkit/example.ts", "front/src/features/board/Example.test.tsx", "scripts/lint/example.test.mjs"])("valem também em %s", async (filePath) => {
    const code = "export async function waitFor(check: () => Promise<boolean>) {\n  while (!(await check())) await new Promise((wake) => setTimeout(wake, 50));\n}";
    const plainCode = filePath.endsWith(".mjs") ? code.replace(": () => Promise<boolean>", "") : code;
    expect(await ruleIdsOf(plainCode, filePath)).toContain("no-restricted-syntax");
  });

  it("as regras de teste não valem no código de produção", async () => {
    const code = 'import { access } from "node:fs/promises";\nexport function exists(path: string) {\n  return access(path).then(() => true, () => false);\n}';
    expect(await ruleIdsOf(code, "back/src/services/example.ts")).toEqual([]);
  });
});

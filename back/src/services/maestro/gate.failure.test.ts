import { describe, it, expect } from "vitest";
import { GATE_OUTPUT_TAIL_BYTES, gateFailureOutput } from "./gate.js";

/**
 * Produção, 2026-11-09 (PR #215 do tech.multi): `npm test --workspaces` roda o front e depois o back.
 * O front morreu na partida (dependência faltando), o back passou 240/240 e o npm saiu com 1. O gate
 * guardava só os últimos 4 KB: o painel mostrou um bloco vermelho só com testes verdes.
 */
function npmWorkspacesRun(): string {
  const back = Array.from({ length: 1200 }, (_, i) => ` ✓ src/services/x${i}.test.ts (4 tests) 12ms`).join("\n");
  return [
    "",
    "=== gate: npm test ===",
    "> wg-ui@1.0.0 test",
    "> front@1.0.0 test",
    "> vitest run",
    "⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-react' imported from /w/front/vitest.config.ts",
    "    at packageResolve (node:internal/modules/esm/resolve:768:81)",
    "npm error Lifecycle script `test` failed with error:",
    "npm error code 1",
    "npm error workspace front@1.0.0",
    "> back@1.0.0 test",
    "> vitest run",
    back,
    " ✓ lifecycle > a failed send does not reopen a question 423ms",
    " Test Files  240 passed (240)",
    "      Tests  2723 passed (2723)",
  ].join("\n");
}

describe("gateFailureOutput — o vermelho mostra o que falhou", () => {
  it("o erro do começo aparece mesmo com dezenas de KB de testes verdes depois", () => {
    const out = gateFailureOutput(npmWorkspacesRun());
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES);
    expect(out).toMatch(/^\[vibehub\] o gate falhou no check: npm test/);
    expect(out).toContain("Cannot find package '@vitejs/plugin-react'");
    expect(out).toContain("npm error workspace front@1.0.0");
    // o fim continua lá: é ele que diz como terminou
    expect(out).toContain("Tests  2723 passed (2723)");
  });

  it("teste verde cujo nome tem 'failed', e o Error que um teste verde loga, não viram linha de erro", () => {
    const run = npmWorkspacesRun().replace("> back@1.0.0 test", "> back@1.0.0 test\n          Error: boom (log de um teste verde)");
    const out = gateFailureOutput(run);
    const errors = out.slice(0, out.indexOf("[vibehub] fim da saída"));
    expect(errors).not.toContain("a failed send");
    expect(errors).not.toContain("Error: boom");
  });

  it("linha de erro colorida (ANSI) também é achada", () => {
    const run = npmWorkspacesRun().replace(" FAIL", "x").replace("npm error code 1", "\x1b[31m FAIL \x1b[39m src/front.test.ts");
    expect(gateFailureOutput(run)).toContain(" FAIL  src/front.test.ts");
  });

  it("falha do vitest: o FAIL e o AssertionError entram nas linhas de erro", () => {
    const run = [
      "=== gate: npm test ===",
      " FAIL  src/a.test.ts > soma > centavos",
      "AssertionError: expected 1 to be 2",
      ...Array.from({ length: 400 }, (_, i) => ` ✓ src/ok${i}.test.ts (1 test) 2ms`),
      " Tests  1 failed | 400 passed (401)",
    ].join("\n");
    const out = gateFailureOutput(run);
    expect(out).toContain("FAIL  src/a.test.ts > soma > centavos");
    expect(out).toContain("AssertionError: expected 1 to be 2");
  });

  it("saída curta segue inteira, só com o check que falhou na frente", () => {
    const out = gateFailureOutput("=== gate: node_modules/.bin/tsc --noEmit ===\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.");
    expect(out).toBe(
      "[vibehub] o gate falhou no check: node_modules/.bin/tsc --noEmit\n\n" +
        "=== gate: node_modules/.bin/tsc --noEmit ===\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.",
    );
  });

  it("Error genéricas não tomam o espaço das linhas que dizem a falha (FAIL, npm error)", () => {
    const noise = Array.from({ length: 80 }, (_, i) => `Error: log ruidoso de um teste verde número ${i} com texto longo o bastante`);
    const run = ["=== gate: npm test ===", ...noise, " FAIL  src/fim.test.ts > o que quebrou", ...Array.from({ length: 300 }, (_, i) => ` ✓ ok${i}.test.ts`)].join("\n");
    const out = gateFailureOutput(run);
    expect(out).toContain("FAIL  src/fim.test.ts > o que quebrou");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES);
  });

  it("prazo estourado ou script morto: o cabeçalho diz que o gate PAROU durante o check, não que ele falhou", () => {
    expect(gateFailureOutput("=== gate: npm test ===\nrodando", "timeout")).toMatch(/^\[vibehub\] o gate passou do prazo durante o check: npm test/);
    expect(gateFailureOutput("=== gate: npm test ===\nrodando", "died")).toMatch(/^\[vibehub\] o gate parou durante o check: npm test/);
  });

  it("check com nome enorme não estoura o teto nem come o fim da saída", () => {
    const long = `node -e "${"x".repeat(5000)}"`;
    const run = [`=== gate: ${long} ===`, " FAIL  a.test.ts", ...Array.from({ length: 300 }, (_, i) => ` ✓ ok${i}.test.ts`), " Tests  1 failed"].join("\n");
    const out = gateFailureOutput(run);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(GATE_OUTPUT_TAIL_BYTES);
    expect(out).toContain(" Tests  1 failed");
    expect(out.split("\n")[0]!.length).toBeLessThan(260);
  });

  it("sem cabeçalho de check (o script morreu antes) devolve a saída como veio", () => {
    expect(gateFailureOutput("boom")).toBe("boom");
  });

  it("dependência faltando na worktree vira uma dica do que fazer, logo abaixo do cabeçalho", () => {
    const out = gateFailureOutput(npmWorkspacesRun());
    expect(out.split("\n").slice(0, 4).join("\n")).toContain(
      "[vibehub] dependência faltando na worktree (@vitejs/plugin-react): rode npm install no card e entregue de novo",
    );
  });

  it("sem dependência faltando, nenhuma dica", () => {
    expect(gateFailureOutput("=== gate: npm test ===\n FAIL  a.test.ts")).not.toContain("dependência faltando");
  });

  it("comando do check que não existe na worktree (sh: vitest: not found) também vira dica", () => {
    const out = gateFailureOutput("=== gate: npm test ===\n> vitest run\nsh: 1: vitest: not found\nnpm error code 127");
    expect(out).toContain("[vibehub] comando não encontrado na worktree (vitest): rode npm install no card e entregue de novo");
  });

  it("disco cheio (ENOSPC) vira dica: não é o código do card", () => {
    const out = gateFailureOutput("=== gate: npm test ===\nError: ENOSPC: no space left on device, write");
    expect(out).toContain("[vibehub] disco do runner cheio (ENOSPC): libere espaço no runner e entregue de novo");
  });
});

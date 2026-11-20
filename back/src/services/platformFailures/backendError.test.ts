import { describe, it, expect } from "vitest";
import {
  extractBackendFrames, readBackendSourceRoot, buildBackendErrorReport, isPlatformFailureLogLine, PLATFORM_FAILURE_LOG_MARK, USER_STOP_WINDOW_MS,
} from "./backendError.js";

const NOW = 1_700_000_000_000;
const STOPPED_CARD = { cardId: "card-7", cardWorktreeSlug: "erp-feat" };

function errorWithStack(message: string, vibehubFile = new URL("../sdk/manager.ts", import.meta.url).href): Error {
  const failure = new Error(message);
  failure.stack = [
    `Error: ${message}`,
    `    at writeToDriver (${vibehubFile}:1339:5)`,
    "    at Object.<anonymous> (/app/node_modules/fastify/lib/route.js:10:1)",
    "    at elsewhere (/home/someone/back/src/services/other.ts:1:1)",
  ].join("\n");
  return failure;
}

describe("relato de erro do backend", () => {
  it("leva só os campos da lista branca e os frames do próprio backend, sem o caminho da instalação", () => {
    const report = buildBackendErrorReport(
      { level: 50, message: "request failed", fields: { err: errorWithStack("driver gone"), route: "/api/x", card: "erp-feat", customerName: "ACME", rawBody: "segredo do negócio" } },
    );
    expect(report).toMatchObject({ source: "backend_error", component: "services/sdk/manager", symptom: "request failed: driver gone" });
    expect(report.evidence).toContain("rota: /api/x");
    expect(report.evidence).toContain("at writeToDriver (services/sdk/manager.ts:1339:5)");
    expect(report.evidence).not.toContain("erp-feat");
    expect(report.evidence).not.toContain("ACME");
    expect(report.evidence).not.toContain("segredo do negócio");
    expect(report.evidence).not.toContain("node_modules");
    expect(report.evidence).not.toContain("/home/someone");
    expect(report.evidence).not.toContain("file://");
  });

  it("a raiz do backend sai do próprio módulo, e no build de produção é /app/dist", () => {
    expect(readBackendSourceRoot("file:///app/dist/services/platformFailures/backendError.js")).toBe("/app/dist/");
  });

  it("instalação em pasta com espaço ou acento ainda reconhece os frames, em URL ou em caminho", () => {
    const backendRoot = readBackendSourceRoot("file:///C:/Users/Jo%C3%A3o/meus%20apps/back/src/services/platformFailures/backendError.ts");
    const failure = new Error("x");
    failure.stack = [
      "Error: x",
      "    at writeToDriver (file:///C:/Users/Jo%C3%A3o/meus%20apps/back/src/services/sdk/manager.ts:1:1)",
      "    at runTurn (C:\\Users\\João\\meus apps\\back\\src\\services\\sdk\\driver.ts:2:2)",
    ].join("\n");
    expect(extractBackendFrames(failure, backendRoot)).toEqual([
      "at writeToDriver (services/sdk/manager.ts:1:1)",
      "at runTurn (services/sdk/driver.ts:2:2)",
    ]);
  });

  it.each([
    ["string", "connect ECONNREFUSED"],
    ["objeto solto", { message: "sem Error" }],
  ])("aceita err como %s sem estourar", (_kind, err) => {
    const report = buildBackendErrorReport({ level: 50, message: "runner provisioning failed", fields: { err } });
    expect(report.symptom.startsWith("runner provisioning failed")).toBe(true);
    expect(report.component).toBe("backend");
  });

  it.each([
    ["do mesmo card até 10s depois do stop dele", "erp-feat", USER_STOP_WINDOW_MS, false],
    ["do mesmo card logado pelo id, não pelo slug", "card-7", 1_000, false],
    ["sem card logo depois de um stop", undefined, 1_000, false],
    ["de outro card logo depois de um stop", "outro-card", 1_000, true],
    ["depois da janela do stop", undefined, USER_STOP_WINDOW_MS + 1, true],
  ])("erro %s vira falha: %s", (_case, loggedCardReference, msSinceStop, isPlatformFailure) => {
    const line = { level: 50, message: "falhou", fields: { err: new Error("write after end"), ...(loggedCardReference ? { card: loggedCardReference } : {}) } };
    expect(isPlatformFailureLogLine(line, { ...STOPPED_CARD, at: NOW - msSinceStop }, NOW)).toBe(isPlatformFailure);
  });

  it.each([
    ["error sem erro anexado", 50, {}, true],
    ["warn com o erro capturado em err", 40, { err: new Error("boom") }, true],
    ["warn com o erro capturado em detail", 40, { detail: "ECONNREFUSED" }, true],
    ["warn sem erro capturado", 40, { card: "c" }, false],
    ["warn com detail vazio", 40, { detail: "" }, false],
    ["info com detail", 30, { detail: "x" }, false],
    ["error do próprio detector de falhas", 50, { ...PLATFORM_FAILURE_LOG_MARK, detail: "disk full" }, false],
    ["warn do próprio detector de falhas", 40, { ...PLATFORM_FAILURE_LOG_MARK, detail: "disk full" }, false],
  ])("%s vira falha: %s", (_case, level, fields, isPlatformFailure) => {
    expect(isPlatformFailureLogLine({ level, message: "algo", fields }, undefined, NOW)).toBe(isPlatformFailure);
  });

  it("Error passado sozinho ao logger não repete a mensagem no sintoma nem na evidência", () => {
    const report = buildBackendErrorReport({ level: 50, message: "write after end", fields: { err: new Error("write after end") } });
    expect(report.symptom).toBe("write after end");
    expect(report.evidence.startsWith("mensagem: write after end\n")).toBe(true);
    expect(report.evidence).not.toContain("erro:");
  });

  it("mascara token que aparece na mensagem de erro", () => {
    const report = buildBackendErrorReport({ level: 50, message: "push failed", fields: { err: `bad ghp_${"A".repeat(36)}` } });
    expect(report.evidence).not.toContain("ghp_");
    expect(report.symptom).not.toContain("ghp_");
  });
});

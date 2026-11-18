import { describe, it, expect } from "vitest";
import { reportFromBackendError, USER_STOP_WINDOW_MS } from "./backendError.js";

const NOW = 1_700_000_000_000;

function errorWithStack(message: string): Error {
  const failure = new Error(message);
  failure.stack = [
    `Error: ${message}`,
    "    at writeToDriver (/app/back/src/services/sdk/manager.ts:1339:5)",
    "    at Object.<anonymous> (/app/node_modules/fastify/lib/route.js:10:1)",
  ].join("\n");
  return failure;
}

describe("relato de erro do backend", () => {
  it("leva só os campos da lista branca e os frames do próprio vibehub", () => {
    const report = reportFromBackendError(
      { level: 50, message: "request failed", fields: { err: errorWithStack("driver gone"), route: "/api/x", card: "erp-feat", customerName: "ACME", rawBody: "segredo do negócio" } },
      undefined,
      NOW,
    );
    expect(report).toMatchObject({ source: "backend_error", component: "services/sdk/manager", symptom: "request failed: driver gone" });
    expect(report.evidence).toContain("rota: /api/x");
    expect(report.evidence).toContain("card: erp-feat");
    expect(report.evidence).toContain("back/src/services/sdk/manager.ts:1339");
    expect(report.evidence).not.toContain("ACME");
    expect(report.evidence).not.toContain("segredo do negócio");
    expect(report.evidence).not.toContain("node_modules");
  });

  it.each([
    ["string", "connect ECONNREFUSED"],
    ["objeto solto", { message: "sem Error" }],
  ])("aceita err como %s sem estourar", (_kind, err) => {
    const report = reportFromBackendError({ level: 50, message: "runner provisioning failed", fields: { err } }, undefined, NOW);
    expect(report.symptom.startsWith("runner provisioning failed")).toBe(true);
    expect(report.component).toBe("backend");
  });

  it("erro até 10s depois de um stop do usuário é marcado 'ao interromper' e aponta o card do stop", () => {
    const report = reportFromBackendError(
      { level: 50, message: "unhandled promise rejection — kept running", fields: { err: new Error("write after end") } },
      { cardId: "card-7", at: NOW - USER_STOP_WINDOW_MS },
      NOW,
    );
    expect(report.symptom).toBe("ao interromper: unhandled promise rejection — kept running: write after end");
    expect(report.cardId).toBe("card-7");
  });

  it("erro depois da janela do stop não é atribuído ao stop", () => {
    const report = reportFromBackendError(
      { level: 50, message: "x", fields: {} },
      { cardId: "card-7", at: NOW - USER_STOP_WINDOW_MS - 1 },
      NOW,
    );
    expect(report.symptom).toBe("x");
    expect(report.cardId).toBeUndefined();
  });

  it("mascara token que aparece na mensagem de erro", () => {
    const report = reportFromBackendError({ level: 50, message: "push failed", fields: { err: `bad ghp_${"A".repeat(36)}` } }, undefined, NOW);
    expect(report.evidence).not.toContain("ghp_");
    expect(report.symptom).not.toContain("ghp_");
  });
});

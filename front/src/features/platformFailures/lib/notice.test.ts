import { describe, it, expect } from "vitest";
import { isActiveFailureStatus, parsePlatformFailureNotice } from "./notice";

const VALID = { id: "f1", source: "agent_report", status: "open", occurrences: 2, firstSeenAt: 10 };

describe("aviso de falha vindo do websocket", () => {
  it("aceita o aviso completo, com explicação e detalhes", () => {
    const details = { symptom: "s", component: "c", evidence: "e", hypothesis: "h" };
    expect(parsePlatformFailureNotice({ ...VALID, explanation: "texto leigo", details })).toEqual({ ...VALID, explanation: "texto leigo", details });
  });

  it.each([
    ["sem id", { ...VALID, id: "" }],
    ["origem desconhecida", { ...VALID, source: "telepathy" }],
    ["status desconhecido", { ...VALID, status: "lost" }],
    ["ocorrências que não são número", { ...VALID, occurrences: "2" }],
    ["detalhes sem evidência", { ...VALID, details: { symptom: "s", component: "c" } }],
    ["um texto no lugar do aviso", "f1"],
  ])("recusa aviso malformado (%s)", (_case, frame) => {
    expect(parsePlatformFailureNotice(frame)).toBeNull();
  });

  it.each(["backend_error", "slow_turn", "stalled_turn", "agent_report"])("aceita a origem %s que o back grava", (source) => {
    expect(parsePlatformFailureNotice({ ...VALID, source })).toEqual({ ...VALID, source });
  });

  it("explicação vazia conta como ausente", () => {
    expect(parsePlatformFailureNotice({ ...VALID, explanation: "" })).not.toHaveProperty("explanation");
  });

  it.each([
    ["open", true], ["investigating", true], ["concluded_without_fix", true], ["resolved", false], ["dismissed", false],
  ] as const)("status %s ativo: %s", (status, isActive) => {
    expect(isActiveFailureStatus(status)).toBe(isActive);
  });
});

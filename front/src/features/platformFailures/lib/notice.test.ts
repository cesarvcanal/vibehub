import { describe, it, expect } from "vitest";
import { isActiveFailureStatus, parsePlatformFailureNotice } from "./notice";

const VALID = { id: "f1", source: "agent_report", status: "open", occurrences: 2, firstSeenAt: 10, lastSeenAt: 20 };
const NARRATIVE = { context: "c", whatHappened: "w", cause: "x", trigger: "person", triggerReason: "r" };
const REPORT = { verdict: "not_a_bug", conclusion: "c", howItHappened: "h", cause: "x", resolution: "r", reportedAt: 30 };

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
    ["sem a última ocorrência", { ...VALID, lastSeenAt: undefined }],
    ["explicação da IA com quem provocou desconhecido", { ...VALID, details: { symptom: "s", component: "c", evidence: "e", narrative: { ...NARRATIVE, trigger: "alien" } } }],
    ["explicação da IA sem a causa", { ...VALID, details: { symptom: "s", component: "c", evidence: "e", narrative: { ...NARRATIVE, cause: "" } } }],
    ["motivo desconhecido de não haver explicação", { ...VALID, details: { symptom: "s", component: "c", evidence: "e", narrativeUnavailable: "preguiça" } }],
    ["um texto no lugar do aviso", "f1"],
    ["conclusão da investigação com veredito desconhecido", { ...VALID, details: { symptom: "s", component: "c", evidence: "e", investigationReport: { ...REPORT, verdict: "talvez" } } }],
    ["conclusão da investigação sem o que resolve", { ...VALID, details: { symptom: "s", component: "c", evidence: "e", investigationReport: { ...REPORT, resolution: "" } } }],
  ])("recusa aviso malformado (%s)", (_case, frame) => {
    expect(parsePlatformFailureNotice(frame)).toBeNull();
  });

  it("aceita a explicação da IA e o motivo de ela faltar nos detalhes", () => {
    const details = { symptom: "s", component: "c", evidence: "e", narrative: NARRATIVE };
    expect(parsePlatformFailureNotice({ ...VALID, details })).toEqual({ ...VALID, details });
    const detailsWithoutNarrative = { symptom: "s", component: "c", evidence: "e", narrativeUnavailable: "no_api_key" };
    expect(parsePlatformFailureNotice({ ...VALID, details: detailsWithoutNarrative })).toEqual({ ...VALID, details: detailsWithoutNarrative });
  });

  it("o aviso no card leva a conclusão da investigação, com e sem a decisão pendente", () => {
    const details = { symptom: "s", component: "c", evidence: "e", investigationReport: REPORT };
    expect(parsePlatformFailureNotice({ ...VALID, details })).toEqual({ ...VALID, details });
    const withDecision = { ...details, investigationReport: { ...REPORT, pendingDecision: "d" } };
    expect(parsePlatformFailureNotice({ ...VALID, details: withDecision })).toEqual({ ...VALID, details: withDecision });
    const withPrevious = { symptom: "s", component: "c", evidence: "e", previousInvestigationReport: REPORT };
    expect(parsePlatformFailureNotice({ ...VALID, details: withPrevious })).toEqual({ ...VALID, details: withPrevious });
  });

  it.each(["backend_error", "slow_turn", "stalled_turn", "agent_report", "screen_error"])("aceita a origem %s que o back grava", (source) => {
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

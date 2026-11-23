import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FailureNarrative } from "./types.js";

const NARRATIVE: FailureNarrative = {
  context: "O card 'entrega' estava abrindo o PR.",
  whatHappened: "O GitHub recusou os comentários do PR.",
  cause: "Provavelmente uma linha comentada fora do diff.",
  trigger: "system",
  triggerReason: "Nenhuma ação de pessoa antes do erro.",
};

async function fresh({ withApiKey = true } = {}) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-failure-narrative-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  env.config.secretKey = "";
  await (await import("../settings/settings.js")).updateSettings({ selfProjectId: "p-vibehub" });
  if (withApiKey) await (await import("../transcribe/transcribe.js")).setTranscribeKeys({ anthropicKey: "sk-ant-test" });
  const failures = await import("./platformFailures.js");
  const narrative = await import("./narrative.js");
  narrative.resetRecentActivityForTesting();
  const failure = (await failures.recordPlatformFailure(
    { source: "backend_error", component: "maestro/deliver", symptom: "deliver failed: comments_failed", evidence: "erro: HTTP 422" }, 1_000_000,
  ))!;
  return { failures, narrative, failure };
}

function stubAnthropic(answer: { status?: number; body?: unknown }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 }));
  vi.stubGlobal("fetch", fetchMock);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  return fetchMock;
}

function anthropicAnswer(text: string, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

function readRequestBody(fetchMock: ReturnType<typeof stubAnthropic>) {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("explicação da falha escrita pela IA", () => {
  it("falha nova ganha contexto, o que aconteceu, a causa e quem provocou, com um pedido enxuto", async () => {
    const { failures, narrative, failure } = await fresh();
    narrative.noteAuditLogLine({ level: 30, message: "turn stopped from the chat", fields: { audit: true, action: "sdk.stop", card: "entrega", by: "cesar", how: "send_now" } }, 999_000);
    const fetchMock = stubAnthropic({ body: anthropicAnswer(JSON.stringify(NARRATIVE)) });
    await narrative.writePlatformFailureNarrative(failure.id);
    expect(await failures.getPlatformFailure(failure.id)).toMatchObject({ narrative: NARRATIVE });
    const requestBody = readRequestBody(fetchMock);
    expect(requestBody).toMatchObject({
      model: narrative.NARRATIVE_MODEL,
      max_tokens: narrative.NARRATIVE_MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(requestBody.messages[0].content).toContain("deliver failed: comments_failed");
    expect(requestBody.messages[0].content).toContain("action=sdk.stop · card=entrega · by=cesar · how=send_now");
  });

  it("só a atividade dos minutos antes do erro entra no pedido, nunca a de depois", async () => {
    const { narrative, failure } = await fresh();
    narrative.noteAuditLogLine({ level: 30, message: "velha", fields: { audit: true, action: "antiga" } }, 1_000_000 - narrative.RECENT_ACTIVITY_WINDOW_MS - 1);
    narrative.noteAuditLogLine({ level: 30, message: "depois", fields: { audit: true, action: "posterior" } }, 1_000_001);
    narrative.noteAuditLogLine({ level: 30, message: "sem auditoria", fields: { action: "comum" } }, 999_000);
    const fetchMock = stubAnthropic({ body: anthropicAnswer(JSON.stringify(NARRATIVE)) });
    await narrative.writePlatformFailureNarrative(failure.id);
    const prompt = readRequestBody(fetchMock).messages[0].content as string;
    expect(prompt).not.toMatch(/antiga|posterior|comum/);
    expect(prompt).toContain("nenhuma ação registrada");
  });

  it("sem chave da Anthropic no cofre, a falha fica marcada sem explicação e nada é chamado", async () => {
    const { failures, narrative, failure } = await fresh({ withApiKey: false });
    const fetchMock = stubAnthropic({ body: anthropicAnswer(JSON.stringify(NARRATIVE)) });
    await narrative.writePlatformFailureNarrative(failure.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await failures.getPlatformFailure(failure.id)).toMatchObject({ narrativeUnavailable: "no_api_key" });
  });

  it("cofre que falha ao ler a chave marca a falha como sem explicação, em vez de deixá-la sem motivo", async () => {
    const { failures, narrative, failure } = await fresh();
    const vault = await import("../../secrets/vault.js");
    vi.spyOn(vault, "secretGet").mockRejectedValueOnce(new Error("bad decrypt"));
    await narrative.writePlatformFailureNarrative(failure.id);
    expect(await failures.getPlatformFailure(failure.id)).toMatchObject({ narrativeUnavailable: "request_failed" });
  });

  it.each([
    ["HTTP de erro", { status: 529, body: { error: "overloaded" } }],
    ["recusa da IA, mesmo com texto válido", { body: anthropicAnswer(JSON.stringify(NARRATIVE), "refusal") }],
    ["JSON fora do formato", { body: anthropicAnswer(JSON.stringify({ ...NARRATIVE, trigger: "alien" })) }],
  ])("falha da IA (%s) marca a falha como sem explicação, sem gravar texto inválido", async (_case, answer) => {
    const { failures, narrative, failure } = await fresh();
    stubAnthropic(answer);
    await narrative.writePlatformFailureNarrative(failure.id);
    const describedFailure = await failures.getPlatformFailure(failure.id);
    expect(describedFailure.narrativeUnavailable).toBe("request_failed");
    expect(describedFailure.narrative).toBeUndefined();
  });
});

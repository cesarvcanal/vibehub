import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fresh({ recordPlatformFailure }: { recordPlatformFailure?: (...args: unknown[]) => Promise<unknown> } = {}) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-platform-watch-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  if (recordPlatformFailure) {
    vi.doMock("./platformFailures.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./platformFailures.js")>()),
      recordPlatformFailure,
    }));
  }
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  await (await import("../settings/settings.js")).updateSettings({ selfProjectId: "p-vibehub" });
  const { logger } = await import("../../utils/logger.js");
  const watch = await import("./watch.js");
  const failures = await import("./platformFailures.js");
  const turnLatency = await import("./turnLatency.js");
  return { logger, watch, failures, turnLatency };
}

afterEach(() => { vi.doUnmock("./platformFailures.js"); });

describe("vigia das falhas da plataforma", () => {
  it("error e warn com o erro capturado viram falha; warn sem erro e info não", async () => {
    const { logger, watch, failures } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    logger.info({ detail: "x" }, "informação");
    logger.warn({ action: "x" }, "aviso sem erro");
    logger.warn({ detail: "ECONNREFUSED" }, "runner probe failed");
    logger.error({ err: new Error("driver gone") }, "request failed");
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect((await failures.listActivePlatformFailures()).map((failure) => failure.symptom).sort())
      .toEqual(["request failed: driver gone", "runner probe failed: ECONNREFUSED"]);
  });

  it("só a falha nova chama a IA para escrever a explicação: repetição e relato de agente não chamam", async () => {
    const { logger, watch, failures } = await fresh();
    await (await import("../transcribe/transcribe.js")).setTranscribeKeys({ anthropicKey: "sk-ant-test" });
    const narrativeAnswer = { context: "c", whatHappened: "w", cause: "x", trigger: "system", triggerReason: "r" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(narrativeAnswer) }] })));
    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const stopWatch = watch.startPlatformFailureWatch();
    logger.error({ err: new Error("driver gone") }, "request failed");
    await watch.waitForPlatformFailureWatch();
    logger.error({ err: new Error("driver gone") }, "request failed");
    await failures.recordPlatformFailure({ source: "agent_report", component: "x", symptom: "y", evidence: "z", explanation: "o agente explicou" });
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const listedFailures = await failures.listActivePlatformFailures();
    expect(listedFailures.find((failure) => failure.source === "backend_error")).toMatchObject({ occurrences: 2, narrative: narrativeAnswer });
    expect(listedFailures.find((failure) => failure.source === "agent_report")?.narrative).toBeUndefined();
  });

  it("erro do card logo depois do stop do usuário não vira falha", async () => {
    const { logger, watch, failures, turnLatency } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    turnLatency.noteUserStop("card-7", "erp-feat", Date.now());
    logger.error({ card: "erp-feat", err: new Error("write after end") }, "sdk driver stdin died");
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  it("o aviso de falha que quebra ao anunciar não vira outra falha nem entra em laço", async () => {
    const { logger, watch, failures } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    const stopListening = failures.onPlatformFailureChange(() => { throw new Error("listener quebrado"); });
    logger.error({ card: "card-1", err: new Error("boom") }, "request failed");
    await failures.recordPlatformFailure({ source: "agent_report", component: "x", symptom: "y", evidence: "z", cardId: "card-1" });
    await watch.waitForPlatformFailureWatch();
    await watch.waitForPlatformFailureWatch();
    stopListening();
    stopWatch();
    expect((await failures.listActivePlatformFailures()).map((failure) => failure.symptom).sort()).toEqual(["request failed: boom", "y"]);
  });

  it("três turnos lentos viram uma falha slow_turn do card", async () => {
    const { watch, failures, turnLatency } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    for (const turnIndex of [0, 1, 2]) {
      const startAt = turnIndex * 60_000;
      turnLatency.noteTurnSent("card-3", startAt);
      turnLatency.noteTurnEvent("card-3", { type: "assistant_delta" }, startAt + turnLatency.SLOW_FIRST_OUTPUT_MS + 1);
      turnLatency.noteTurnEvent("card-3", { type: "result" }, startAt + turnLatency.SLOW_FIRST_OUTPUT_MS + 2);
    }
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(await failures.listActivePlatformFailures()).toEqual([expect.objectContaining({ source: "slow_turn", affectedCardIds: ["card-3"] })]);
  });

  it("turno parado sem ferramenta rodando vira uma falha stalled_turn do card, com o momento do último sinal", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    onTestFinished(() => { vi.useRealTimers(); });
    const { watch, failures, turnLatency } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    const sentAt = Date.now();
    turnLatency.noteTurnSent("card-4", sentAt);
    turnLatency.noteTurnEvent("card-4", { type: "assistant_text" }, sentAt + 2_000);
    await vi.advanceTimersByTimeAsync(turnLatency.STALLED_TURN_MS + watch.STALL_CHECK_INTERVAL_MS + 2_000);
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(await failures.listActivePlatformFailures()).toEqual([expect.objectContaining({
      source: "stalled_turn",
      component: "sdk/turn",
      affectedCardIds: ["card-4"],
      evidence: expect.stringContaining(`último sinal do agente: ${new Date(sentAt + 2_000).toISOString()}`),
    })]);
  });

  it("turno esperando um comando do agente não vira falha, por mais longo que seja", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    onTestFinished(() => { vi.useRealTimers(); });
    const { watch, failures, turnLatency } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    const sentAt = Date.now();
    turnLatency.noteTurnSent("card-4", sentAt);
    turnLatency.noteTurnEvent("card-4", { type: "tool_use", id: "bash-1" }, sentAt + 2_000);
    await vi.advanceTimersByTimeAsync(10 * turnLatency.STALLED_TURN_MS);
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  it("gravar falhou: a captura de erros do backend pausa por 60s em vez de realimentar o próprio erro", async () => {
    const recordSpy = vi.fn(async () => { throw new Error("disk full"); });
    const { logger, watch } = await fresh({ recordPlatformFailure: recordSpy });
    const stopWatch = watch.startPlatformFailureWatch();
    logger.error("primeiro erro");
    await watch.waitForPlatformFailureWatch();
    logger.error("segundo erro, dentro da pausa");
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});

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
  it("um logger.error vira falha registrada; um warn não", async () => {
    const { logger, watch, failures } = await fresh();
    const stopWatch = watch.startPlatformFailureWatch();
    logger.warn({ action: "x" }, "melhor esforço que falhou");
    logger.error({ err: new Error("driver gone") }, "request failed");
    await watch.waitForPlatformFailureWatch();
    stopWatch();
    expect((await failures.listActivePlatformFailures()).map((failure) => failure.symptom)).toEqual(["request failed: driver gone"]);
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

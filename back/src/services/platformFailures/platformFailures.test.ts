import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformFailureReport } from "./types.js";

async function fresh({ configured = true } = {}) {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-platform-failures-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  const settings = await import("../settings/settings.js");
  if (configured) await settings.updateSettings({ selfProjectId: "p-vibehub" });
  return await import("./platformFailures.js");
}

function backendReport(symptom: string, cardId?: string): PlatformFailureReport {
  return { source: "backend_error", component: "services/sdk/manager", symptom, evidence: `mensagem: ${symptom}`, ...(cardId ? { cardId } : {}) };
}

describe("registro de falhas da plataforma", () => {
  it("não registra nada enquanto o projeto do vibehub não está configurado", async () => {
    const failures = await fresh({ configured: false });
    expect(await failures.recordPlatformFailure(backendReport("driver gone"))).toBeNull();
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  it("a mesma falha repetida só soma ocorrências e cards afetados", async () => {
    const failures = await fresh();
    await failures.recordPlatformFailure(backendReport("timed out after 91000 ms", "card-1"), 1_000);
    await failures.recordPlatformFailure(backendReport("timed out after 95000 ms", "card-2"), 2_000);
    await failures.recordPlatformFailure(backendReport("timed out after 99000 ms", "card-1"), 3_000);
    const listed = await failures.listActivePlatformFailures();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ occurrences: 3, affectedCardIds: ["card-2", "card-1"], firstSeenAt: 1_000, lastSeenAt: 3_000, status: "open" });
  });

  it("falha descartada como 'não é bug' não volta", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("expected thing"));
    await failures.dismissPlatformFailure(recorded!.id);
    expect(await failures.recordPlatformFailure(backendReport("expected thing"))).toBeNull();
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  async function resolveFailureAt(failures: Awaited<ReturnType<typeof fresh>>, mergedAt: number) {
    const recorded = await failures.recordPlatformFailure(backendReport("driver gone"), mergedAt - 1_000);
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.setPlatformFailureInvestigationCard(recorded!.id, "fix-card");
    await failures.settlePlatformFailureInvestigation("fix-card", { merged: true }, mergedAt);
    return recorded!;
  }

  it("falha resolvida que reaparece depois da carência abre uma entrada nova (regressão depois do merge)", async () => {
    const failures = await fresh();
    const mergedAt = 10_000_000;
    const recorded = await resolveFailureAt(failures, mergedAt);
    const reopened = await failures.recordPlatformFailure(backendReport("driver gone"), mergedAt + failures.RESOLVED_GRACE_MS + 1);
    expect(reopened!.id).not.toBe(recorded.id);
    expect(reopened).toMatchObject({ status: "open", occurrences: 1 });
  });

  it("na carência depois do merge, o código antigo ainda no ar só soma na resolvida, sem abrir entrada", async () => {
    const failures = await fresh();
    const mergedAt = 10_000_000;
    const recorded = await resolveFailureAt(failures, mergedAt);
    const duringDeploy = await failures.recordPlatformFailure(backendReport("driver gone"), mergedAt + failures.RESOLVED_GRACE_MS);
    expect(duringDeploy).toMatchObject({ id: recorded.id, status: "resolved", occurrences: 2 });
    expect(await failures.listActivePlatformFailures()).toEqual([]);
  });

  it("'não é bug' numa lentidão silencia por 7 dias, e depois a detecção volta", async () => {
    const failures = await fresh();
    const slowTurn: PlatformFailureReport = { source: "slow_turn", component: "sdk/turn", symptom: "primeira resposta acima de 90s", evidence: "episódio antigo" };
    const recorded = await failures.recordPlatformFailure(slowTurn, 1_000);
    await failures.dismissPlatformFailure(recorded!.id, 2_000);
    expect(await failures.recordPlatformFailure(slowTurn, 2_000 + failures.SLOW_TURN_DISMISSAL_MS)).toBeNull();
    const back = await failures.recordPlatformFailure({ ...slowTurn, evidence: "episódio novo", cardId: "card-9" }, 2_001 + failures.SLOW_TURN_DISMISSAL_MS);
    expect(back).toMatchObject({ status: "open", occurrences: 1, evidence: "episódio novo", affectedCardIds: ["card-9"], firstSeenAt: 2_001 + failures.SLOW_TURN_DISMISSAL_MS });
    expect(back!.id).not.toBe(recorded!.id);
    expect((await failures.listActivePlatformFailures()).map((failure) => failure.id)).toEqual([back!.id]);
    const repeated = await failures.recordPlatformFailure(slowTurn, 3_000 + failures.SLOW_TURN_DISMISSAL_MS);
    expect(repeated).toMatchObject({ id: back!.id, occurrences: 2 });
    await expect(failures.getPlatformFailure(recorded!.id)).rejects.toBeInstanceOf(failures.PlatformFailureNotFoundError);
  });

  it("'não é bug' num erro do backend continua valendo depois dos 7 dias", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("expected thing"), 1_000);
    await failures.dismissPlatformFailure(recorded!.id, 2_000);
    expect(await failures.recordPlatformFailure(backendReport("expected thing"), 3_000 + failures.SLOW_TURN_DISMISSAL_MS)).toBeNull();
  });

  it("investigação concluída sem merge volta para decisão do dono", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("driver gone"));
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.setPlatformFailureInvestigationCard(recorded!.id, "fix-card");
    expect(await failures.settlePlatformFailureInvestigation("fix-card", { merged: false }))
      .toMatchObject({ status: "concluded_without_fix", investigationCardId: "fix-card" });
  });

  it("acima do teto de falhas ativas, uma falha nova é descartada e uma conhecida ainda soma", async () => {
    const failures = await fresh();
    for (const index of Array.from({ length: failures.ACTIVE_FAILURES_CAP }, (_unused, position) => position)) {
      await failures.recordPlatformFailure({ ...backendReport("x"), component: `component-${String.fromCharCode(97 + (index % 26))}${Math.floor(index / 26)}` });
    }
    expect(await failures.recordPlatformFailure({ ...backendReport("x"), component: "brand-new" })).toBeNull();
    expect(await failures.recordPlatformFailure({ ...backendReport("x"), component: "component-a0" })).toMatchObject({ occurrences: 2 });
  });

  it("dispensar falha em investigação é recusado", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("driver gone"));
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await expect(failures.dismissPlatformFailure(recorded!.id)).rejects.toBeInstanceOf(failures.PlatformFailureStateError);
  });

  it("id desconhecido lança not found", async () => {
    const failures = await fresh();
    await expect(failures.getPlatformFailure("nope")).rejects.toBeInstanceOf(failures.PlatformFailureNotFoundError);
  });

  it("guarda a explicação e o card de origem do primeiro relato", async () => {
    const failures = await fresh();
    await failures.recordPlatformFailure({ ...backendReport("medidor velho", "card-1"), explanation: "O medidor mostrou a conta antiga." });
    const repeated = await failures.recordPlatformFailure({ ...backendReport("medidor velho", "card-2"), explanation: "outra explicação" });
    expect(repeated).toMatchObject({ explanation: "O medidor mostrou a conta antiga.", originCardId: "card-1" });
  });

  it("falha sem card não tem card de origem", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("driver gone"));
    expect(recorded).not.toHaveProperty("originCardId");
    expect(recorded).not.toHaveProperty("explanation");
  });

  it("lista só as falhas ativas que afetam o card", async () => {
    const failures = await fresh();
    const ofCard = await failures.recordPlatformFailure(backendReport("a", "card-1"));
    await failures.recordPlatformFailure({ ...backendReport("b", "card-2"), component: "other" });
    const dismissed = await failures.recordPlatformFailure({ ...backendReport("c", "card-1"), component: "third" });
    await failures.dismissPlatformFailure(dismissed!.id);
    expect((await failures.listActivePlatformFailuresOfCard("card-1")).map((failure) => failure.id)).toEqual([ofCard!.id]);
  });

  it("reconhece a assinatura já descartada como 'não é bug'", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("expected thing"));
    expect(await failures.isPlatformFailureDismissed(backendReport("expected thing"))).toBe(false);
    await failures.dismissPlatformFailure(recorded!.id);
    expect(await failures.isPlatformFailureDismissed(backendReport("expected thing"))).toBe(true);
  });
});

describe("aviso de falha por card", () => {
  function listenTo(failures: Awaited<ReturnType<typeof fresh>>, cardId: string) {
    const heard: { id: string; status: string; occurrences: number }[] = [];
    const stop = failures.onCardFailureChange(cardId, (failure) => heard.push({ id: failure.id, status: failure.status, occurrences: failure.occurrences }));
    onTestFinished(stop);
    return heard;
  }

  it("avisa o card só na primeira ocorrência dele, e o card novo quando a falha o alcança", async () => {
    const failures = await fresh();
    const heardByCard1 = listenTo(failures, "card-1");
    const heardByCard2 = listenTo(failures, "card-2");
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    expect(heardByCard1).toEqual([expect.objectContaining({ status: "open", occurrences: 1 })]);
    expect(heardByCard2).toEqual([]);
    await failures.recordPlatformFailure(backendReport("timed out", "card-2"));
    expect(heardByCard2).toEqual([expect.objectContaining({ status: "open", occurrences: 3 })]);
    expect(heardByCard1).toHaveLength(1);
  });

  it("mudança de status avisa todos os cards afetados", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    await failures.recordPlatformFailure(backendReport("timed out", "card-2"));
    const heardByCard1 = listenTo(failures, "card-1");
    const heardByCard2 = listenTo(failures, "card-2");
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.releasePlatformFailureInvestigation(recorded!.id, "open");
    await failures.dismissPlatformFailure(recorded!.id);
    const expectedStatuses = ["investigating", "open", "dismissed"];
    expect(heardByCard1.map((heard) => heard.status)).toEqual(expectedStatuses);
    expect(heardByCard2.map((heard) => heard.status)).toEqual(expectedStatuses);
  });

  it("investigação encerrada avisa os cards afetados", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.setPlatformFailureInvestigationCard(recorded!.id, "fix-card");
    const heardByCard1 = listenTo(failures, "card-1");
    await failures.settlePlatformFailureInvestigation("fix-card", { merged: true });
    expect(heardByCard1.map((heard) => heard.status)).toEqual(["resolved"]);
  });

  it("um ouvinte que lança não impede o registro nem os outros ouvintes", async () => {
    const failures = await fresh();
    onTestFinished(failures.onCardFailureChange("card-1", () => { throw new Error("socket quebrado"); }));
    const heardByCard1 = listenTo(failures, "card-1");
    expect(await failures.recordPlatformFailure(backendReport("timed out", "card-1"))).toMatchObject({ occurrences: 1 });
    expect(heardByCard1).toHaveLength(1);
  });

  it("depois de parar de ouvir, o card não recebe mais nada", async () => {
    const failures = await fresh();
    const heard: string[] = [];
    const stop = failures.onCardFailureChange("card-1", (failure) => heard.push(failure.id));
    stop();
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    expect(heard).toEqual([]);
  });
});

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

const INVESTIGATION_REPORT = { verdict: "not_a_bug" as const, conclusion: "c", howItHappened: "h", cause: "x", resolution: "r" };

async function startInvestigation(failures: Awaited<ReturnType<typeof fresh>>, investigationCardId: string): Promise<string> {
  const recorded = await failures.recordPlatformFailure(backendReport("driver gone"));
  await failures.claimPlatformFailureInvestigation(recorded!.id);
  await failures.setPlatformFailureInvestigationCard(recorded!.id, investigationCardId);
  return recorded!.id;
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

  it.each([
    ["uma lentidão", { source: "slow_turn", component: "sdk/turn", symptom: "primeira resposta acima de 90s", evidence: "episódio antigo" }],
    ["um turno parado", { source: "stalled_turn", component: "sdk/turn", symptom: "turno parado: nenhum sinal do agente por mais de 3 min", evidence: "episódio antigo" }],
  ] satisfies Array<[string, PlatformFailureReport]>)("'não é bug' n%s silencia por 7 dias, e depois a detecção volta", async (_case, slowTurn) => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(slowTurn, 1_000);
    await failures.dismissPlatformFailure(recorded!.id, 2_000);
    expect(await failures.recordPlatformFailure(slowTurn, 2_000 + failures.TURN_DISMISSAL_MS)).toBeNull();
    const back = await failures.recordPlatformFailure({ ...slowTurn, evidence: "episódio novo", cardId: "card-9" }, 2_001 + failures.TURN_DISMISSAL_MS);
    expect(back).toMatchObject({ status: "open", occurrences: 1, evidence: "episódio novo", affectedCardIds: ["card-9"], firstSeenAt: 2_001 + failures.TURN_DISMISSAL_MS });
    expect(back!.id).not.toBe(recorded!.id);
    expect((await failures.listActivePlatformFailures()).map((failure) => failure.id)).toEqual([back!.id]);
    const repeated = await failures.recordPlatformFailure(slowTurn, 3_000 + failures.TURN_DISMISSAL_MS);
    expect(repeated).toMatchObject({ id: back!.id, occurrences: 2 });
    await expect(failures.getPlatformFailure(recorded!.id)).rejects.toBeInstanceOf(failures.PlatformFailureNotFoundError);
  });

  it("'não é bug' num erro do backend continua valendo depois dos 7 dias", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("expected thing"), 1_000);
    await failures.dismissPlatformFailure(recorded!.id, 2_000);
    expect(await failures.recordPlatformFailure(backendReport("expected thing"), 3_000 + failures.TURN_DISMISSAL_MS)).toBeNull();
  });

  it("investigação concluída sem merge volta para decisão do dono", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("driver gone"));
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.setPlatformFailureInvestigationCard(recorded!.id, "fix-card");
    expect(await failures.settlePlatformFailureInvestigation("fix-card", { merged: false }))
      .toMatchObject({ status: "concluded_without_fix", investigationCardId: "fix-card" });
  });

  it("a conclusão do card de investigação fica na falha depois que o card termina sem merge", async () => {
    const failures = await fresh();
    const failureId = await startInvestigation(failures, "fix-card");
    const report = {
      verdict: "not_a_bug" as const,
      conclusion: "O gate parou a suíte no prazo, como deve.",
      howItHappened: "O projeto não tem gate próprio e o npm test inteiro passou de 10 min.",
      cause: "Suíte lenta do projeto.",
      resolution: "Criar um gate só dos testes afetados no projeto.",
      pendingDecision: "Tratar o estouro do npm test padrão como vermelho do projeto?",
    };
    await failures.saveFailureInvestigationReport("fix-card", report, 5_000);
    await failures.settlePlatformFailureInvestigation("fix-card", { merged: false });
    expect(await failures.getPlatformFailure(failureId))
      .toMatchObject({ status: "concluded_without_fix", investigationReport: { ...report, reportedAt: 5_000 } });
  });

  it("conclusão de investigação vinda de um card que não investiga falha nenhuma é recusada", async () => {
    const failures = await fresh();
    const failureId = await startInvestigation(failures, "fix-card");
    await expect(failures.saveFailureInvestigationReport("other-card", INVESTIGATION_REPORT)).rejects.toBeInstanceOf(failures.PlatformFailureStateError);
    expect(await failures.getPlatformFailure(failureId)).not.toHaveProperty("investigationReport");
  });

  it("investigar de novo tira a conclusão do topo e a guarda como investigação anterior", async () => {
    const failures = await fresh();
    const failureId = await startInvestigation(failures, "card-a");
    await failures.saveFailureInvestigationReport("card-a", INVESTIGATION_REPORT, 5_000);
    await failures.settlePlatformFailureInvestigation("card-a", { merged: false });
    const reclaimed = await failures.claimPlatformFailureInvestigation(failureId);
    expect(reclaimed.failure).not.toHaveProperty("investigationReport");
    expect(reclaimed.failure.previousInvestigationReport).toMatchObject({ ...INVESTIGATION_REPORT, reportedAt: 5_000 });
  });

  it("o card novo que termina sem gravar conclusão não herda a conclusão do card anterior", async () => {
    const failures = await fresh();
    const failureId = await startInvestigation(failures, "card-a");
    await failures.saveFailureInvestigationReport("card-a", INVESTIGATION_REPORT);
    await failures.settlePlatformFailureInvestigation("card-a", { merged: false });
    await failures.claimPlatformFailureInvestigation(failureId);
    await failures.setPlatformFailureInvestigationCard(failureId, "card-b");
    await failures.settlePlatformFailureInvestigation("card-b", { merged: false });
    const failure = await failures.getPlatformFailure(failureId);
    expect(failure).not.toHaveProperty("investigationReport");
    expect(failure.previousInvestigationReport?.conclusion).toBe(INVESTIGATION_REPORT.conclusion);
  });

  it("se o card novo não chega a receber o pedido, a conclusão anterior volta a ser a atual", async () => {
    const failures = await fresh();
    const failureId = await startInvestigation(failures, "card-a");
    await failures.saveFailureInvestigationReport("card-a", INVESTIGATION_REPORT);
    await failures.settlePlatformFailureInvestigation("card-a", { merged: false });
    const { statusBeforeClaim } = await failures.claimPlatformFailureInvestigation(failureId);
    const released = await failures.releasePlatformFailureInvestigation(failureId, statusBeforeClaim);
    expect(released).toMatchObject({ status: "concluded_without_fix", investigationReport: { conclusion: INVESTIGATION_REPORT.conclusion } });
    expect(released).not.toHaveProperty("previousInvestigationReport");
  });

  it("acima do teto de falhas ativas, uma falha nova é descartada e uma conhecida ainda soma", async () => {
    const failures = await fresh();
    for (const index of Array.from({ length: failures.ACTIVE_FAILURES_CAP }, (_unused, position) => position)) {
      await failures.recordPlatformFailure({ ...backendReport("x"), component: `component-${String.fromCharCode(97 + (index % 26))}${Math.floor(index / 26)}` });
    }
    expect(await failures.recordPlatformFailure({ ...backendReport("x"), component: "brand-new" })).toBeNull();
    expect(await failures.recordPlatformFailure({ ...backendReport("x"), component: "component-a0" })).toMatchObject({ occurrences: 2 });
  });

  it("relatos de tela em excesso não descartam falha do backend", async () => {
    const failures = await fresh();
    const screenReport = (message: string): PlatformFailureReport => ({ source: "screen_error", component: "front", symptom: message, evidence: `mensagem: ${message}` });
    for (const index of Array.from({ length: failures.ACTIVE_FAILURES_CAP }, (_unused, position) => position)) {
      await failures.recordPlatformFailure(screenReport(`erro de tela ${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`));
    }
    expect(await failures.recordPlatformFailure(screenReport("mais um erro de tela"))).toBeNull();
    expect(await failures.recordPlatformFailure(backendReport("driver gone"))).toMatchObject({ source: "backend_error", occurrences: 1 });
    expect((await failures.listActivePlatformFailures()).filter((failure) => failure.source === "screen_error")).toHaveLength(failures.ACTIVE_SCREEN_ERRORS_CAP);
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

describe("sinal de mudança de falha", () => {
  function listen(failures: Awaited<ReturnType<typeof fresh>>) {
    const heard: { id: string; status: string; occurrences: number; newForCardId?: string }[] = [];
    onTestFinished(failures.onPlatformFailureChange(({ failure, newForCardId }) => {
      heard.push({ id: failure.id, status: failure.status, occurrences: failure.occurrences, ...(newForCardId ? { newForCardId } : {}) });
    }));
    return heard;
  }

  it("anuncia a falha quando ela alcança um card pela primeira vez, e não na repetição no mesmo card", async () => {
    const failures = await fresh();
    const heard = listen(failures);
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    await failures.recordPlatformFailure(backendReport("timed out", "card-2"));
    expect(heard).toEqual([
      expect.objectContaining({ status: "open", occurrences: 1, newForCardId: "card-1" }),
      expect.objectContaining({ status: "open", occurrences: 3, newForCardId: "card-2" }),
    ]);
  });

  it("falha nova sem card é anunciada só como criada, e a repetição dela não é anunciada", async () => {
    const failures = await fresh();
    const heardCreations: boolean[] = [];
    onTestFinished(failures.onPlatformFailureChange(({ isCreated, newForCardId }) => {
      heardCreations.push(isCreated === true && newForCardId === undefined);
    }));
    await failures.recordPlatformFailure(backendReport("driver gone"));
    await failures.recordPlatformFailure(backendReport("driver gone"));
    expect(heardCreations).toEqual([true]);
  });

  it("cada mudança de status é anunciada sem card novo", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    const heard = listen(failures);
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.releasePlatformFailureInvestigation(recorded!.id, "open");
    await failures.claimPlatformFailureInvestigation(recorded!.id);
    await failures.setPlatformFailureInvestigationCard(recorded!.id, "fix-card");
    await failures.settlePlatformFailureInvestigation("fix-card", { merged: true });
    expect(heard).toEqual(["investigating", "open", "investigating", "resolved"].map((status) => expect.objectContaining({ status })));
    expect(heard.some((change) => change.newForCardId)).toBe(false);
  });

  it("a conclusão da investigação é anunciada, para o aviso nos cards afetados atualizar sem recarregar", async () => {
    const failures = await fresh();
    await startInvestigation(failures, "fix-card");
    const heardVerdicts: (string | undefined)[] = [];
    onTestFinished(failures.onPlatformFailureChange(({ failure }) => heardVerdicts.push(failure.investigationReport?.verdict)));
    await failures.saveFailureInvestigationReport("fix-card", { ...INVESTIGATION_REPORT, verdict: "vibehub_bug" });
    expect(heardVerdicts).toEqual(["vibehub_bug"]);
  });

  it("descarte é anunciado", async () => {
    const failures = await fresh();
    const recorded = await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    const heard = listen(failures);
    await failures.dismissPlatformFailure(recorded!.id);
    expect(heard).toEqual([expect.objectContaining({ status: "dismissed" })]);
  });

  it("um ouvinte que lança não impede o registro nem os outros ouvintes", async () => {
    const failures = await fresh();
    onTestFinished(failures.onPlatformFailureChange(() => { throw new Error("socket quebrado"); }));
    const heard = listen(failures);
    expect(await failures.recordPlatformFailure(backendReport("timed out", "card-1"))).toMatchObject({ occurrences: 1 });
    expect(heard).toHaveLength(1);
  });

  it("depois de parar de ouvir, nada mais chega", async () => {
    const failures = await fresh();
    const heard: string[] = [];
    const stop = failures.onPlatformFailureChange(({ failure }) => heard.push(failure.id));
    stop();
    await failures.recordPlatformFailure(backendReport("timed out", "card-1"));
    expect(heard).toEqual([]);
  });
});

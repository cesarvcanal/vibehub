import type { PublicUser } from "../../auth/users.js";
import { getCard, updateCard, type Card, type CardPr } from "../board/registry.js";
import { cardBranch } from "../board/workspace.js";
import { deliver, gateAtCommit, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import type { GateResult } from "../maestro/gate.js";
import { isBusy } from "../maestro/maestro.js";
import { logger } from "../../utils/logger.js";
import { analysisVerdict, type AnalysisMergeGate, type AnalysisMergeRefusal, type AnalysisReport } from "./analysisModel.js";
import { getAnalysis, getAnalysisMergeGate, saveAnalysisMergeGate, saveAnalysisMergeRefusal } from "./analysisStore.js";
import { ownGithubConnection } from "./merge.js";

export type AnalysisMergeOutcome =
  | { kind: "merged"; result: DeliverResult }
  | { kind: "refused"; status: 400 | 404 | 409; reason: string; error: string; result?: DeliverResult };

export type AnalysisMergeGateOutcome =
  | { kind: "started" | "current"; mergeGate: AnalysisMergeGate }
  | { kind: "refused"; status: 404 | 409; reason: string; error: string };

export function analysedPr(card: Card, analysis: AnalysisReport): CardPr | undefined {
  return card.prs?.find((pr) => pr.url === analysis.prUrl);
}

export function isAnalysisMergeable(analysis: AnalysisReport, pr: CardPr): boolean {
  return analysisVerdict(analysis) === "apt" && pr.mergedAt === undefined;
}

export function currentMergeRefusal(analysis: AnalysisReport, refusal: AnalysisMergeRefusal | undefined): AnalysisMergeRefusal | undefined {
  return refusal?.analysedSha === analysis.analysedSha ? refusal : undefined;
}

export function currentMergeGate(analysis: AnalysisReport, gate: AnalysisMergeGate | undefined): AnalysisMergeGate | undefined {
  return gate?.analysedSha === analysis.analysedSha ? gate : undefined;
}

const mergingCardIds = new Set<string>();
const mergeGateCardIds = new Set<string>();

export async function startAnalysisMergeGate(cardId: string, opts: { again?: boolean } = {}): Promise<AnalysisMergeGateOutcome> {
  const [card, analysis, recorded] = await Promise.all([getCard(cardId), getAnalysis(cardId), getAnalysisMergeGate(cardId)]);
  if (!card) return { kind: "refused", status: 404, reason: "not_found", error: "card not found" };
  const pr = analysis && analysedPr(card, analysis);
  if (!analysis || !pr || !isAnalysisMergeable(analysis, pr)) {
    return { kind: "refused", status: 409, reason: "not_apt", error: "a análise não está apta: não há merge para testar" };
  }
  if (isBusy(card)) {
    return { kind: "refused", status: 409, reason: "card_working", error: "o card de análise está no meio de um turno: os testes do merge esperam ele terminar" };
  }
  const current = currentMergeGate(analysis, recorded);
  const orphaned = current?.state === "running" && !mergeGateCardIds.has(cardId);
  const rerunAsked = opts.again === true && current?.state === "failed";
  if (current && !orphaned && !rerunAsked) return { kind: "current", mergeGate: current };
  if (mergeGateCardIds.has(cardId)) return { kind: "refused", status: 409, reason: "gate_running", error: "os testes do merge já estão rodando" };
  mergeGateCardIds.add(cardId);
  const started: AnalysisMergeGate = { cardId, analysedSha: analysis.analysedSha, state: "running", at: Date.now() };
  if (!(await saveAnalysisMergeGate(started))) {
    mergeGateCardIds.delete(cardId);
    return { kind: "refused", status: 409, reason: "not_apt", error: "a análise mudou de commit enquanto os testes do merge começavam" };
  }
  void runAnalysisMergeGate(started, pr.url, card.worktreeSlug)
    .catch((err: unknown) => logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not record the analysis merge gate verdict"))
    .finally(() => mergeGateCardIds.delete(cardId));
  return { kind: "started", mergeGate: started };
}

async function runAnalysisMergeGate(started: AnalysisMergeGate, prUrl: string, cardSlug: string): Promise<void> {
  const verdict: GateResult = await gateAtCommit(started.cardId, prUrl, started.analysedSha).catch((err: unknown) => ({
    ran: true, passed: false, output: `o gate não chegou a rodar: ${(err as Error).message}`,
  }));
  const landed = await saveAnalysisMergeGate(verdict.passed
    ? { cardId: started.cardId, analysedSha: started.analysedSha, state: "passed", at: Date.now() }
    : { cardId: started.cardId, analysedSha: started.analysedSha, state: "failed", output: verdict.output, at: Date.now() });
  logger.info(
    { audit: true, action: "analysis.merge_gate", card: cardSlug, sha: started.analysedSha, passed: verdict.passed, landed },
    verdict.passed ? "analysis merge gate passed" : "analysis merge gate failed",
  );
}

export function isAnalysisMerging(cardId: string): boolean {
  return mergingCardIds.has(cardId);
}

const MERGE_ALREADY_RUNNING = "merge já em andamento";

export async function mergeAnalysedPr(cardId: string, user: PublicUser): Promise<AnalysisMergeOutcome> {
  if (mergingCardIds.has(cardId)) return { kind: "refused", status: 409, reason: "merging", error: MERGE_ALREADY_RUNNING };
  mergingCardIds.add(cardId);
  try {
    return await mergeClaimedAnalysis(cardId, user);
  } finally {
    mergingCardIds.delete(cardId);
  }
}

export async function deliverOwnAnalysis(card: Card, opts: DeliverOpts & { by: string }): Promise<DeliverResult> {
  if (mergingCardIds.has(card.id)) {
    return {
      merged: false, reason: "merge_failed", branch: opts.branch ?? card.base, cardBranch: cardBranch(card),
      output: `${MERGE_ALREADY_RUNNING} neste card (pelo painel ou por outra ordem): este pedido não fez nada; o resultado aparece no painel da análise`,
    };
  }
  mergingCardIds.add(card.id);
  try {
    const analysedSha = (await getAnalysis(card.id))?.analysedSha;
    const result = await deliver(card.id, opts);
    if (analysedSha) await saveMergeOutcome(card.id, analysedSha, result, opts.by);
    return result;
  } finally {
    mergingCardIds.delete(card.id);
  }
}

async function saveMergeOutcome(cardId: string, analysedSha: string, result: DeliverResult, by: string): Promise<void> {
  const refusal = result.merged
    ? undefined
    : { cardId, analysedSha, reason: result.reason, ...(result.output ? { output: result.output } : {}), by, at: Date.now() };
  await saveAnalysisMergeRefusal(cardId, refusal);
}

async function mergeClaimedAnalysis(cardId: string, user: PublicUser): Promise<AnalysisMergeOutcome> {
  const [card, analysis] = await Promise.all([getCard(cardId), getAnalysis(cardId)]);
  if (!card) return { kind: "refused", status: 404, reason: "not_found", error: "card not found" };
  const pr = analysis && analysedPr(card, analysis);
  if (pr?.mergedAt !== undefined) {
    return { kind: "refused", status: 409, reason: "already_merged", error: `o PR #${pr.number} já foi mergeado` };
  }
  if (!analysis || !pr || !isAnalysisMergeable(analysis, pr)) {
    return {
      kind: "refused", status: 409, reason: "not_apt",
      error: "a análise não está apta: o merge só sai com ela concluída, sem bloqueante aberto, sem dúvida sem resposta e com todas as dimensões verificadas",
    };
  }
  if (isBusy(card)) {
    return {
      kind: "refused", status: 409, reason: "card_working",
      error: "o card de análise está no meio de um turno: o merge libera quando ele terminar, para não levar um commit que ninguém analisou",
    };
  }
  const connectionId = await ownGithubConnection(user, card);
  if (!connectionId) {
    return {
      kind: "refused", status: 400, reason: "merger_sem_github",
      error: "merger_sem_github: quem mergeia não tem uma conexão GitHub própria no vibehub",
    };
  }
  const gate = await startAnalysisMergeGate(cardId);
  if (gate.kind === "refused") return gate;
  if (gate.mergeGate.state === "running") {
    return {
      kind: "refused", status: 409, reason: "gate_running",
      error: `os testes do merge estão rodando no commit analisado (${analysis.analysedSha.slice(0, 7)}): o merge libera quando ficarem verdes`,
    };
  }
  if (gate.mergeGate.state === "failed") {
    return { kind: "refused", status: 409, reason: "gate", error: gate.mergeGate.output ?? "os testes do merge falharam no commit analisado" };
  }
  const result = await deliver(cardId, {
    authorized: true, branch: pr.base, connectionId, by: user.username,
    mergeOnly: true, expectedHeadSha: analysis.analysedSha, gatePassed: true,
  });
  await saveMergeOutcome(cardId, analysis.analysedSha, result, user.username);
  logger.info(
    { audit: true, action: "analysis.merge", card: card.worktreeSlug, pr: pr.number, merged: result.merged, reason: result.reason, by: user.username },
    result.merged ? "analysed PR merged from the analysis panel" : "analysed PR merge did not happen",
  );
  if (!result.merged) {
    return { kind: "refused", status: 409, reason: result.reason, error: result.output ?? `merge não feito: ${result.reason}`, result };
  }
  await updateCard(cardId, { column: "done" });
  return { kind: "merged", result };
}

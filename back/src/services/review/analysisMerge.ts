import type { PublicUser } from "../../auth/users.js";
import { getCard, updateCard, type Card, type CardPr } from "../board/registry.js";
import { cardBranch } from "../board/workspace.js";
import { afterPrMerged, deliver, gateAtCommit, readPrState, type DeliverOpts, type DeliverResult } from "../maestro/deliver.js";
import { readWorktreeHead, type GateResult } from "../maestro/gate.js";
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
const mergeGateRunStarts = new Map<string, number>();

const GITHUB_SYNC_MS = 60_000;
const lastGithubSync = new Map<string, number>();

export async function syncAnalysisWithGithub(cardId: string): Promise<void> {
  if (mergingCardIds.has(cardId)) return;
  const [card, analysis] = await Promise.all([getCard(cardId), getAnalysis(cardId)]);
  const pr = card && analysis && analysedPr(card, analysis);
  if (!pr || pr.mergedAt !== undefined) return;
  const now = Date.now();
  if (now - (lastGithubSync.get(cardId) ?? 0) < GITHUB_SYNC_MS) return;
  lastGithubSync.set(cardId, now);
  const github = await readPrState(cardId, pr.url);
  if (github?.state !== "MERGED" || mergingCardIds.has(cardId)) return;
  await afterPrMerged(cardId, pr.url, pr.base, pr.branch);
  logger.info(
    { audit: true, action: "analysis.merged_outside", card: card.worktreeSlug, pr: pr.number, head: github.headSha },
    "analysed PR found merged on GitHub, outside the panel",
  );
}

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
  const runStartedAt = mergeGateRunStarts.get(cardId);
  const verdictAfterRun = current !== undefined && current.state !== "running" && runStartedAt !== undefined && current.at >= runStartedAt;
  const runLive = runStartedAt !== undefined && !verdictAfterRun;
  const orphaned = current?.state === "running" && !runLive;
  const rerunAsked = opts.again === true && current?.state === "failed";
  if (current && !orphaned && !rerunAsked) return { kind: "current", mergeGate: current };
  if (runLive) return { kind: "refused", status: 409, reason: "gate_running", error: "os testes do merge já estão rodando" };
  const started: AnalysisMergeGate = { cardId, analysedSha: analysis.analysedSha, state: "running", at: Date.now() };
  mergeGateRunStarts.set(cardId, started.at);
  const forgetRun = () => {
    if (mergeGateRunStarts.get(cardId) === started.at) mergeGateRunStarts.delete(cardId);
  };
  if (!(await saveAnalysisMergeGate(started))) {
    forgetRun();
    return { kind: "refused", status: 409, reason: "not_apt", error: "a análise mudou de commit enquanto os testes do merge começavam" };
  }
  void runAnalysisMergeGate(started, pr.url, card.worktreeSlug)
    .catch((err: unknown) => logger.warn({ card: card.worktreeSlug, detail: (err as Error).message }, "could not record the analysis merge gate verdict"))
    .finally(forgetRun);
  return { kind: "started", mergeGate: started };
}

async function deliveredHead(cardId: string, prUrl: string): Promise<{ sha: string } | { refusal: string }> {
  const [github, worktreeHead] = await Promise.all([readPrState(cardId, prUrl), readWorktreeHead(cardId)]);
  if (!github) return { refusal: "não deu para ler o PR no GitHub: os testes do merge rodam de novo pelo botão" };
  if (!worktreeHead) return { refusal: "não deu para ler o commit da worktree do card de análise" };
  if (github.headSha !== worktreeHead) {
    return {
      refusal: `o PR está em ${github.headSha.slice(0, 7)} e a análise entregou ${worktreeHead.slice(0, 7)}: o PR andou depois da análise ` +
        "(ou a correção dela não subiu). O merge só sai do commit que a análise conferiu: peça uma análise nova do PR.",
    };
  }
  return { sha: worktreeHead };
}

async function runAnalysisMergeGate(started: AnalysisMergeGate, prUrl: string, cardSlug: string): Promise<void> {
  const head = await deliveredHead(started.cardId, prUrl).catch((err: unknown) => ({ refusal: `o gate não chegou a rodar: ${(err as Error).message}` }));
  const verdict: Pick<GateResult, "passed" | "output"> = "refusal" in head
    ? { passed: false, output: head.refusal }
    : await gateAtCommit(started.cardId, prUrl, head.sha).catch((err: unknown) => ({
      ran: true, passed: false, output: `o gate não chegou a rodar: ${(err as Error).message}`,
    }));
  const pinned = "sha" in head ? { sha: head.sha } : {};
  const landed = await saveAnalysisMergeGate(verdict.passed
    ? { cardId: started.cardId, analysedSha: started.analysedSha, ...pinned, state: "passed", at: Date.now() }
    : { cardId: started.cardId, analysedSha: started.analysedSha, ...pinned, state: "failed", output: verdict.output, at: Date.now() });
  logger.info(
    { audit: true, action: "analysis.merge_gate", card: cardSlug, analysed: started.analysedSha, ...pinned, passed: verdict.passed, landed },
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
  if (gate.mergeGate.state === "failed" || !gate.mergeGate.sha) {
    return { kind: "refused", status: 409, reason: "gate", error: gate.mergeGate.output ?? "os testes do merge não disseram em que commit passaram" };
  }
  const result = await deliver(cardId, {
    authorized: true, branch: pr.base, connectionId, by: user.username,
    mergeOnly: true, expectedHeadSha: gate.mergeGate.sha, gatePassed: true,
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

/**
 * REVISÃO DE PR — regras puras. Aqui moram as invariantes que o servidor impõe à IA do revisor e à do
 * autor, para que o loop não dependa de boa vontade de prompt: bloqueante só com prova, lista fechada
 * a partir da rodada 2 e teto de rodadas. Sem I/O; o orquestrador persiste e dispara os relays.
 */

export const MAX_ROUNDS = 3;

export type ReviewPhase = "reviewing" | "fixing" | "ready" | "impasse" | "merged" | "cancelled";
export type FindingSeverity = "blocking" | "suggestion" | "question" | "refuted";
/** `wontfix`: o autor decidiu não aplicar uma SUGESTÃO, com o motivo (sugestão não bloqueia; bloqueante não aceita). */
export type FindingStatus = "open" | "fixed" | "contested" | "accepted_risk" | "dropped" | "wontfix";

/** O que o autor responde de um achado: corrigido, contestado (com prova) ou, só em sugestão, não vai aplicar. */
export type AuthorAnswerStatus = "fixed" | "contested" | "wontfix";

export interface FindingProof {
  kind: "failing_test" | "rule" | "scenario";
  ref: string;
  detail?: string;
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  file?: string;
  line?: number;
  proof?: FindingProof;
  fix?: string;
  status: FindingStatus;
  introducedInRound: number;
  commit?: string;
  authorReply?: string;
  reviewerReply?: string;
  humanDecision?: "keep" | "accept_risk" | "block" | "drop";
}

/**
 * Um achado citado numa fala, com o que aquele lado disse dele NAQUELE momento: o achado guarda só a
 * última resposta de cada lado, e a conversa das IAs precisa da de cada rodada.
 */
export interface ReviewEventItem {
  id: string;
  status: FindingStatus;
  reply?: string;
  commit?: string;
  /** O achado nasceu nesta fala (a rodada do revisor que o abriu). */
  isNew?: boolean;
}

export interface ReviewEvent {
  at: number;
  round: number;
  who: "reviewer" | "author" | "system" | "human";
  text: string;
  /** Os achados de que a fala trata. Ausente nas falas de sistema e nas gravadas antes deste campo. */
  items?: ReviewEventItem[];
  /** Quem fez, nas falas humanas (o username). */
  by?: string;
}

export interface Review {
  id: string;
  cardId: string;
  projectId: string;
  prNumber: number;
  prUrl: string;
  prBranch: string;
  base: string;
  reviewerUserId: string;
  authorUserId: string;
  coauthorUserId?: string;
  mergerUserId: string;
  reviewerCardId: string;
  round: number;
  phase: ReviewPhase;
  findings: Finding[];
  log: ReviewEvent[];
  reviewedSha?: string;
  /**
   * O head do PR na última vez que alguém o viu (o revisor ao submeter, o autor ao responder, a
   * conferência do GitHub). Diferente de `reviewedSha` = o PR andou depois da revisão: o painel mostra.
   */
  prHeadSha?: string;
  impasseReason?: string;
  /**
   * `ready`, mas o pedido de Approve não chegou ao card do revisor: o PR segue com o
   * `--request-changes` da rodada 1 no GitHub. O merge humano não fica preso; o painel oferece
   * "tentar de novo" (retryReview), e o relay que dá certo limpa a marca.
   */
  approvePending?: boolean;
  lastSubmitRound?: number;
  lastRespondRound?: number;
  nudges: number;
  createdAt: number;
  updatedAt: number;
}

/** `introducedInRound` é opcional na entrada: na rodada 2+ ele é a marca "criado pela correção". */
export type SubmittedFinding = Omit<Finding, "id" | "status" | "introducedInRound"> & {
  id?: string;
  introducedInRound?: number;
};

const PROOF_KINDS: ReadonlySet<string> = new Set(["failing_test", "rule", "scenario"]);

function hasProof(p: FindingProof | undefined): boolean {
  return !!p && PROOF_KINDS.has(p.kind) && typeof p.ref === "string" && p.ref.trim() !== "";
}

/**
 * Transforma o que a IA do revisor mandou em achados novos. Bloqueante sem prova é rebaixado a
 * sugestão (o servidor, não o prompt, garante). Da rodada 2 em diante a lista é fechada: só entra
 * achado novo que o revisor marcou como criado pela correção (`introducedInRound === round`); itens
 * que citam um id já existente são vereditos (vão por `applyReviewerVerdicts`) e não geram achado novo.
 */
export function normalizeSubmittedFindings(input: SubmittedFinding[], round: number, existing: Finding[]): Finding[] {
  const known = new Set(existing.map((f) => f.id));
  const out: Finding[] = [];
  for (const item of input) {
    if (item.id && known.has(item.id)) continue;
    if (round >= 2 && item.introducedInRound !== round) {
      throw new Error(
        `lista fechada: a rodada ${round} não aceita achado novo sem introducedInRound=${round} ` +
          `(só o que a correção do autor introduziu): "${item.title}"`,
      );
    }
    const severity = item.severity === "blocking" && !hasProof(item.proof) ? "suggestion" : item.severity;
    // Allowlist explícita: humanDecision, commit, authorReply e reviewerReply são do servidor/humano/autor
    // e nunca podem vir da IA do revisor (uma dúvida já "decidida" liberaria o ready sem humano).
    const finding: Finding = {
      id: `f${existing.length + out.length + 1}`,
      severity,
      title: item.title,
      status: "open",
      introducedInRound: round,
    };
    if (item.file !== undefined) finding.file = item.file;
    if (item.line !== undefined) finding.line = item.line;
    if (item.proof !== undefined) finding.proof = item.proof;
    if (item.fix !== undefined) finding.fix = item.fix;
    out.push(finding);
  }
  return out;
}

function mustFind(findings: Finding[], id: string): Finding {
  const f = findings.find((x) => x.id === id);
  if (!f) throw new Error(`achado desconhecido: ${id}`);
  return f;
}

/** Vereditos do revisor sobre achados existentes. Devolve a lista nova; não muta a revisão. */
export function applyReviewerVerdicts(
  review: Review,
  updates: { id: string; status: FindingStatus; reviewerReply?: string }[],
): Finding[] {
  const out = review.findings.map((f) => ({ ...f }));
  for (const u of updates) {
    const f = mustFind(out, u.id);
    f.status = u.status;
    if (u.reviewerReply !== undefined) f.reviewerReply = u.reviewerReply;
  }
  return out;
}

/**
 * Respostas do autor. Contestar e não aplicar exigem justificativa: uma resposta muda não dá ao revisor
 * o que julgar. `wontfix` só vale para sugestão — bloqueante se corrige ou se contesta com prova.
 */
export function applyAuthorResponses(
  review: Review,
  items: { id: string; status: AuthorAnswerStatus; commit?: string; reply: string }[],
): Finding[] {
  const out = review.findings.map((f) => ({ ...f }));
  for (const it of items) {
    const f = mustFind(out, it.id);
    if (it.status !== "fixed" && (it.reply ?? "").trim() === "") {
      throw new Error(`${it.status === "wontfix" ? "não aplicar" : "contestar"} o achado ${it.id} exige uma resposta`);
    }
    if (it.status === "wontfix" && f.severity !== "suggestion") {
      throw new Error(`wontfix vale só para sugestão: ${it.id} é ${f.severity} (corrija ou conteste com prova)`);
    }
    f.status = it.status;
    f.authorReply = it.reply;
    if (it.commit !== undefined) f.commit = it.commit;
  }
  return out;
}

const isOpen = (f: Finding): boolean => f.status === "open" || f.status === "contested";

/** Bloqueantes ainda em pé (abertos ou contestados). */
export function blockingOpen(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "blocking" && isOpen(f));
}

/**
 * Dúvidas que esperam decisão: nenhum humano decidiu e ainda estão em pé. Uma dúvida que o autor
 * resolveu e o revisor conferiu (`fixed`), ou que o revisor retirou (`dropped`), não espera ninguém.
 */
export function pendingQuestions(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "question" && !f.humanDecision && isOpen(f));
}

/**
 * Próxima fase, chamada DEPOIS de aplicar a rodada do revisor (`review.round` = rodada recém-revisada).
 * Dúvida decidida como `block` pesa como bloqueante; `drop` conta como resolvida. Dúvida pendente
 * sozinha segura o ready sem gastar rodada (espera o humano); com bloqueante aberto a regra normal vence.
 */
export function phaseAfterReviewerRound(review: Review): { phase: ReviewPhase; impasseReason?: string } {
  const blocking =
    blockingOpen(review.findings).length +
    review.findings.filter((f) => f.severity === "question" && f.humanDecision === "block" && isOpen(f)).length;
  if (blocking > 0) {
    return review.round >= MAX_ROUNDS ? { phase: "impasse", impasseReason: "rodadas" } : { phase: "fixing" };
  }
  if (pendingQuestions(review.findings).length > 0) return { phase: "reviewing" };
  return { phase: "ready" };
}

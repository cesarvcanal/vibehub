/**
 * REVISÃO DE PR — regras puras. Aqui moram as invariantes que o servidor impõe à IA do revisor e à do
 * autor, para que o loop não dependa de boa vontade de prompt: bloqueante só com prova, lista fechada
 * a partir da rodada 2 e teto de rodadas. Sem I/O; o orquestrador persiste e dispara os relays.
 */

export const MAX_ROUNDS = 3;

export type ReviewPhase = "reviewing" | "fixing" | "ready" | "impasse" | "merged" | "cancelled";
export type FindingSeverity = "blocking" | "suggestion" | "question" | "refuted";
export type FindingStatus = "open" | "fixed" | "contested" | "accepted_risk" | "dropped";

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

export interface ReviewEvent {
  at: number;
  round: number;
  who: "reviewer" | "author" | "system" | "human";
  text: string;
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
  impasseReason?: string;
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
    const { id: _id, introducedInRound: _r, ...rest } = item;
    const severity = item.severity === "blocking" && !hasProof(item.proof) ? "suggestion" : item.severity;
    out.push({
      ...rest,
      severity,
      id: `f${existing.length + out.length + 1}`,
      status: "open",
      introducedInRound: round,
    });
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

/** Respostas do autor. Contestar exige justificativa: contestação muda não dá ao revisor o que julgar. */
export function applyAuthorResponses(
  review: Review,
  items: { id: string; status: "fixed" | "contested"; commit?: string; reply: string }[],
): Finding[] {
  const out = review.findings.map((f) => ({ ...f }));
  for (const it of items) {
    const f = mustFind(out, it.id);
    if (it.status === "contested" && (it.reply ?? "").trim() === "") {
      throw new Error(`contestar o achado ${it.id} exige uma resposta`);
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

/** Dúvidas que esperam decisão humana. */
export function pendingQuestions(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "question" && !f.humanDecision);
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

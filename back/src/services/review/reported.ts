/**
 * O QUE O AUTOR ENCONTROU — regras puras. A IA do autor acha problemas no caminho que o revisor não
 * apontou: um bug que ela corrigiu neste PR, ou um que viu e deixou fora do escopo. Antes isso ficava
 * só no chat do card e o painel da revisão dizia "tudo certo"; agora ela relata (`vibehub_pr_report`),
 * o relato fica no PR do card e o painel mostra. Sem I/O: o registry guarda, a rota e o painel leem.
 */

/** `fixed`: encontrado e corrigido neste PR (com o commit). `out_of_scope`: encontrado, não é deste PR. */
export type ReportedProblemKind = "fixed" | "out_of_scope";

export interface ReportedProblem {
  /** `a1`, `a2`… por PR: o `a` separa dos achados do revisor (`f1`, `f2`…). */
  id: string;
  kind: ReportedProblemKind;
  /** Uma linha: o problema. */
  title: string;
  /** O que acontecia, por quê, e o que foi feito (ou por que fica para depois). */
  detail: string;
  /** Só em `fixed`: o commit da correção. */
  commit?: string;
  file?: string;
  line?: number;
  /** Quando foi relatado ou atualizado pela última vez (epoch ms). */
  at: number;
}

/** O que a ferramenta recebe: sem `id` é item novo (ou o de mesmo título); com `id`, atualiza aquele. */
export interface ReportedProblemInput {
  id?: string;
  kind: ReportedProblemKind;
  title: string;
  detail: string;
  commit?: string;
  file?: string;
  line?: number;
}

/** Teto por PR: o relato é do que importa, não um log. */
export const REPORTED_MAX = 50;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const sameTitle = (a: string, b: string): boolean => oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

/**
 * Aplica um relato à lista do PR e devolve a lista nova (não muta a recebida). Item com `id` atualiza
 * aquele (id desconhecido é erro); sem `id`, um de mesmo título é atualizado — chamar de novo não
 * duplica —, e o resto entra como `a<n+1>`. Corrigido sem commit não entra: é o commit que deixa o
 * revisor conferir. PURE.
 */
export function applyReportedProblems(existing: ReportedProblem[], items: ReportedProblemInput[], now: number): ReportedProblem[] {
  const out = existing.map((p) => ({ ...p }));
  let next = out.reduce((max, p) => Math.max(max, Number(p.id.slice(1)) || 0), 0);
  for (const item of items) {
    const title = oneLine(item.title ?? "");
    const detail = (item.detail ?? "").trim();
    const commit = (item.commit ?? "").trim();
    if (!title) throw new Error("relato sem título: diga em uma linha qual é o problema");
    if (!detail) throw new Error(`relato "${title}" sem detalhe: diga o que acontecia e o que foi feito`);
    if (item.kind === "fixed" && !commit) throw new Error(`relato "${title}" marcado como corrigido exige o commit da correção`);
    const target = item.id !== undefined ? out.find((p) => p.id === item.id) : out.find((p) => sameTitle(p.title, title));
    if (item.id !== undefined && !target) throw new Error(`relato desconhecido: ${item.id}`);
    const problem: ReportedProblem = target ?? { id: "", kind: item.kind, title, detail, at: now };
    if (!target) {
      if (out.length >= REPORTED_MAX) throw new Error(`limite de ${REPORTED_MAX} relatos por PR`);
      next += 1;
      problem.id = `a${next}`;
      out.push(problem);
    }
    problem.kind = item.kind;
    problem.title = title;
    problem.detail = detail;
    problem.at = now;
    if (item.kind === "fixed") problem.commit = commit;
    else delete problem.commit;
    if (item.file !== undefined) problem.file = item.file;
    if (item.line !== undefined) problem.line = item.line;
  }
  return out;
}

const where = (p: ReportedProblem): string => (p.file ? ` (${p.file}${p.line !== undefined ? `:${p.line}` : ""})` : "");
const label = (p: ReportedProblem): string =>
  p.kind === "fixed" ? `${p.id} corrigido neste PR (${p.commit})` : `${p.id} fora do escopo${where(p)}`;

/** A fala do autor na conversa da revisão, numa linha (o painel lista o resto na aba Achados). PURE. */
export function reportedSummary(list: ReportedProblem[]): string {
  const n = list.length;
  const head = `Relatei ${n} ${n === 1 ? "problema" : "problemas"} que encontrei no trabalho, além do que o revisor apontou (aba Achados): `;
  return head + list.map((p) => `${label(p)}: ${p.title}`).join("; ");
}

/**
 * O bloco do prompt do revisor com o que o autor relatou: para conferir o que ele diz ter corrigido
 * como parte do PR. Não são achados do revisor (não entram na lista dele). Vazio sem relato. PURE.
 */
export function reportedForReviewer(list: ReportedProblem[]): string {
  if (list.length === 0) return "";
  return [
    "",
    "O autor relatou o que encontrou no trabalho, além do que você apontou (não são achados seus: confira os",
    "corrigidos como parte do PR, e aponte um achado só se a correção estiver errada):",
    ...list.map((p) => `- ${label(p)}: ${p.title} — ${p.detail}`),
  ].join("\n");
}

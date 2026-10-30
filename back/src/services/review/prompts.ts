import { MAX_ROUNDS, pendingQuestions, type Finding, type FindingStatus, type Review } from "./model.js";
import { reportedForReviewer, type ReportedProblem } from "./reported.js";

/**
 * TEXTOS DA REVISÃO DE PR — o que o orquestrador digita no card do revisor e no do autor.
 *
 * Cada texto é AUTOSSUFICIENTE: o card que recebe não tem o contexto da revisão (o do revisor nasceu
 * agora; o do autor pode estar há dias em outra conversa). Por isso todos dizem, com todas as letras,
 * as quatro coisas que o loop precisa: que a IA NUNCA mergeia, a regra de bloqueio por prova, onde
 * estamos (revisão, PR, rodada N de 3) e qual ferramenta chamar no fim, com o `card` exato.
 *
 * O que veio da outra IA (títulos, respostas, provas) entra numa linha só e com teto: o texto viaja
 * por um heredoc até o tmux, e uma resposta de várias páginas não ajuda ninguém a decidir.
 *
 * Funções puras: a revisão entra, o texto sai.
 */

const TOOL_SUBMIT = "vibehub_review_submit";
const TOOL_RESPOND = "vibehub_review_respond";
const TOOL_REPORT = "vibehub_pr_report";

/**
 * O que o autor encontra no caminho e o revisor não apontou vai ao painel, não só ao chat: sem isso o
 * painel diz "tudo certo" enquanto o chat do card conta outra história.
 */
const REPORT_WHAT_YOU_FIND =
  "Se no caminho você encontrar um problema que o revisor não apontou (e corrigir, ou deixar fora do escopo), relate " +
  `com a ferramenta MCP ${TOOL_REPORT} (card: o seu; items: [{ kind: "fixed" com o commit | "out_of_scope", title, detail }]). ` +
  "O relato aparece no painel da revisão e o revisor confere: não deixe só no chat.";

/** Uma linha, sem quebras, com teto. O que a outra IA escreveu nunca vira um bloco solto no prompt. */
export function oneLine(text: string | undefined, max = 300): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATUS_PT: Record<FindingStatus, string> = {
  open: "aberto",
  fixed: "corrigido",
  contested: "contestado",
  accepted_risk: "risco aceito",
  dropped: "retirado",
  wontfix: "não vai aplicar",
};

function header(r: Review): string {
  return (
    `[vibehub · revisão de PR] Revisão ${r.id} · PR #${r.prNumber} (${r.prUrl}) · ` +
    `branch ${r.prBranch} -> ${r.base} · rodada ${r.round} de ${MAX_ROUNDS}.`
  );
}

/** As regras que valem para os dois lados, ditas igual nos quatro textos. */
function rules(): string {
  return [
    "Regras desta revisão:",
    "- NUNCA mergeie o PR: nada de `gh pr merge`, nada de vibehub_deliver. O merge é um botão humano no vibehub.",
    "- Só bloqueia com prova: teste que falha, regra escrita do repo citada (arquivo e trecho), ou risco concreto de quebrar " +
      "funcionalidade existente (cenário com arquivo:linha). O resto é sugestão: aparece, não bloqueia, não abre rodada.",
  ].join("\n");
}

const where = (f: Finding): string => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "");

function proofText(f: Finding): string {
  if (!f.proof) return "sem prova";
  const detail = f.proof.detail ? ` — ${oneLine(f.proof.detail, 200)}` : "";
  return `${f.proof.kind} ${oneLine(f.proof.ref, 160)}${detail}`;
}

/** Um achado em uma linha de cabeçalho e uma de detalhes: o que é, onde, a prova e o que cada lado disse. */
function findingLine(f: Finding): string {
  const loc = where(f);
  const tags = [f.severity, STATUS_PT[f.status], f.humanDecision ? `decisão humana: ${f.humanDecision}` : ""].filter(Boolean);
  const head = `- ${f.id} [${tags.join(", ")}] ${oneLine(f.title, 200)}${loc ? ` (${loc})` : ""}`;
  const parts = [`prova: ${proofText(f)}`];
  if (f.fix) parts.push(`correção proposta: ${oneLine(f.fix, 200)}`);
  if (f.authorReply !== undefined) parts.push(`autor: "${oneLine(f.authorReply)}"${f.commit ? ` (commit ${oneLine(f.commit, 60)})` : ""}`);
  if (f.reviewerReply !== undefined) parts.push(`revisor: "${oneLine(f.reviewerReply)}"`);
  return `${head}\n    ${parts.join("; ")}`;
}

const lines = (list: Finding[], empty: string): string => (list.length ? list.map(findingLine).join("\n") : `  (${empty})`);

/**
 * O que o autor precisa resolver (e o revisor julgar): bloqueante, ou dúvida que o humano decidiu
 * bloquear, ainda em pé. Sugestões e itens fechados (corrigidos, retirados, risco aceito) ficam fora.
 */
export function actionableForAuthor(f: Finding): boolean {
  const blocks = f.severity === "blocking" || (f.severity === "question" && f.humanDecision === "block");
  return blocks && (f.status === "open" || f.status === "contested");
}

/**
 * O que o revisor julga numa rodada de delta: o que bloqueia e não foi retirado nem aceito como risco
 * (por humano ou não). Item que um humano mandou bloquear entra: o revisor confere o "corrigido" dele.
 */
function underReview(f: Finding): boolean {
  const blocks = f.severity === "blocking" || (f.severity === "question" && f.humanDecision === "block");
  const humanClosed = f.humanDecision === "accept_risk" || f.humanDecision === "drop";
  return blocks && f.status !== "accepted_risk" && f.status !== "dropped" && !humanClosed;
}

const FINDING_FIELDS =
  "findings: [{ severity: \"blocking\" | \"suggestion\" | \"question\" | \"refuted\", title, file?, line?, " +
  "proof?: { kind: \"failing_test\" | \"rule\" | \"scenario\", ref, detail? }, fix? }]";

function classification(): string {
  return [
    "Classifique cada achado:",
    "- blocking: SÓ com prova. proof.kind = failing_test (ref = o teste que falha, ex. src/x.test.ts:12), rule (ref = a regra " +
      "escrita do repo, ex. CLAUDE.md, com o trecho em detail) ou scenario (ref = arquivo:linha, detail = o cenário concreto " +
      "que quebra, inclusive funcionalidade que já existia). Bloqueante sem prova vira sugestão no servidor.",
    "- suggestion: melhoria que não bloqueia.",
    "- question: risco que pode comprometer, mas você não tem certeza. Fica esperando decisão: o revisor humano decide no " +
      "painel, ou o autor resolve/explica e você confere na rodada seguinte. O ciclo segue com o resto.",
    "- refuted: achado que a verificação derrubou (fica só no histórico).",
  ].join("\n");
}

function submitCall(r: Review, extra: string): string {
  return [
    `No fim, chame a ferramenta MCP ${TOOL_SUBMIT} com:`,
    `  card: "${r.reviewerCardId}"   (o $VIBEHUB_CARD_ID deste terminal)`,
    `  review: "${r.id}"`,
    `  round: ${r.round}`,
    "  headSha: o sha completo de `git rev-parse HEAD` (40 caracteres)",
    "  summary: uma ou duas frases com o resultado da rodada",
    `  ${extra}`,
    "Não termine o turno sem chamar essa ferramenta: é ela que leva a rodada adiante.",
  ].join("\n");
}

/**
 * O que fazer quando o `gh pr review` falha. O GitHub recusa review (e Approve) do próprio PR, e a
 * conta do revisor pode não ter permissão: a IA que parasse no erro terminaria o turno sem a
 * ferramenta, e a revisão iria a impasse "IA não respondeu" a cada rodada. O registro no vibehub é o
 * que leva o loop adiante; o GitHub é a vitrine.
 */
function ghReviewFallback(tool: string): string {
  return (
    "   Se o `gh pr review` falhar (ex.: o GitHub recusa review do próprio PR, ou a conta não tem permissão), não pare: " +
    `chame ${tool} mesmo assim, com o erro no summary.`
  );
}

function reviewerIdentity(): string {
  return "Você é o REVISOR deste PR. Não escreva no código do autor: não faça commit, não faça push, não chame vibehub_deliver.";
}

/** Rodada 1: revisão completa do PR com o /code-review, publicada no GitHub e entregue estruturada. */
export function reviewerRoundPrompt(r: Review, reported: ReportedProblem[] = []): string {
  return [
    header(r),
    reviewerIdentity(),
    rules(),
    ...(reported.length ? [reportedForReviewer(reported)] : []),
    "",
    "1. Ponha o worktree na cabeça do PR:",
    `   git fetch origin && git reset --hard origin/${r.prBranch}`,
    "   e guarde o sha: git rev-parse HEAD",
    `2. Rode /code-review high no PR #${r.prNumber} (com a etapa de verificação que tenta derrubar cada achado).`,
    `3. ${classification()}`,
    "4. Publique a rodada no GitHub, na sua conta, com a lista (severidade, arquivo:linha, prova, correção proposta):",
    `   - com algum blocking: gh pr review ${r.prNumber} --request-changes --body "<lista>"`,
    `   - sem blocking: gh pr review ${r.prNumber} --comment --body "<lista>"`,
    ghReviewFallback(TOOL_SUBMIT),
    `5. ${submitCall(r, FINDING_FIELDS)}`,
  ].join("\n");
}

/** Os achados que o autor respondeu depois da última fala do revisor: o que o revisor ainda não conferiu. */
function answeredSinceReviewer(r: Review): Set<string> {
  const lastReviewer = r.log.map((e) => e.who).lastIndexOf("reviewer");
  const ids = new Set<string>();
  for (const e of r.log.slice(lastReviewer + 1)) {
    if (e.who === "author") for (const it of e.items ?? []) ids.add(it.id);
  }
  return ids;
}

/** Rodada 2+: só o diff desde a rodada anterior, contra a lista fechada. */
export function reviewerDeltaPrompt(r: Review, reported: ReportedProblem[] = []): string {
  const judged = r.findings.filter(underReview);
  const humanBlocked = judged.filter((f) => f.humanDecision === "block" || f.humanDecision === "keep");
  const waiting = pendingQuestions(r.findings);
  // As sugestões em aberto, e as que o autor respondeu depois da última fala do revisor (ele ainda não conferiu).
  const answered = answeredSinceReviewer(r);
  // Dúvida que o autor respondeu (resolvida ou explicada) e nenhum humano decidiu: o revisor confere.
  const answeredDoubts = r.findings.filter((f) => f.severity === "question" && !f.humanDecision && answered.has(f.id));
  const stillWaiting = waiting.filter((f) => !answered.has(f.id));
  const suggestions = r.findings.filter((f) => f.severity === "suggestion" && (f.status === "open" || answered.has(f.id)));
  const since = r.reviewedSha
    ? `git diff ${r.reviewedSha}..HEAD`
    : "o PR inteiro (não há sha da rodada anterior)";
  return [
    header(r),
    reviewerIdentity(),
    "O autor respondeu à lista da rodada anterior e empurrou as correções.",
    rules(),
    ...(reported.length ? [reportedForReviewer(reported)] : []),
    "",
    "1. Ponha o worktree na cabeça do PR:",
    `   git fetch origin && git reset --hard origin/${r.prBranch}`,
    "   e guarde o sha: git rev-parse HEAD",
    `2. Revise SÓ o que mudou desde a rodada anterior: ${since}`,
    "   Confira cada item da lista fechada contra esse diff e contra a resposta do autor.",
    "3. Lista fechada (dê um veredito para cada item):",
    lines(judged, "nenhum item em aberto"),
    ...(humanBlocked.length
      ? [
        `   ${humanBlocked.map((f) => f.id).join(", ")}: um humano mandou bloquear. Só fixed ou open; dropped é ignorado ` +
          "pelo servidor (a IA não retira o que um humano bloqueou).",
      ]
      : []),
    ...(answeredDoubts.length
      ? [
        "   Dúvidas que o autor respondeu: fixed se ele resolveu de verdade, dropped se você aceita a explicação, open se " +
          "continua dúvida (aí ela volta a esperar o revisor humano).",
        lines(answeredDoubts, ""),
      ]
      : []),
    ...(stillWaiting.length
      ? ["   Esperando o revisor humano (não dê veredito):", lines(stillWaiting, "")]
      : []),
    ...(suggestions.length
      ? [
        "   Sugestões (não bloqueiam): dê fixed só às que o diff aplicou de verdade; open se o autor disse que aplicou e não " +
          "aplicou; dropped se aceitar o motivo de um contestado/não vai aplicar; as demais, deixe fora dos vereditos.",
        lines(suggestions, ""),
      ]
      : []),
    "   Vereditos possíveis, e só estes: fixed (corrigido de verdade, conferido no diff), open (continua; diga o porquê em " +
      "reviewerReply), dropped (você aceita a contestação do autor).",
    `4. Achado novo só entra se a PRÓPRIA correção criou o bug: marque introducedInRound: ${r.round}. Qualquer outro achado ` +
      "novo é recusado pelo servidor (a lista é fechada).",
    `5. Publique a rodada no GitHub: gh pr review ${r.prNumber} --request-changes --body "<vereditos>" se sobrar bloqueante ` +
      `aberto; senão gh pr review ${r.prNumber} --comment --body "<vereditos>".`,
    ghReviewFallback(TOOL_SUBMIT),
    `6. ${submitCall(
      r,
      `verdicts: [{ id, status: "fixed" | "open" | "dropped", reviewerReply? }], findings: [] (ou só os novos com introducedInRound: ${r.round})`,
    )}`,
  ].join("\n");
}

/**
 * A lista fechada para o autor: corrigir o que é bug no escopo, contestar só com prova. Com co-autor
 * na revisão, `coauthorTrailer` é a linha `Co-authored-by: Nome <email>` que dá a ele o crédito no Git.
 */
export function authorFixPrompt(r: Review, opts: { coauthorTrailer?: string } = {}): string {
  const todo = r.findings.filter(actionableForAuthor);
  const waiting = pendingQuestions(r.findings);
  const suggestions = r.findings.filter((f) => f.severity === "suggestion" && f.status === "open");
  return [
    header(r),
    "O revisor encontrou problemas no seu PR. Siga a skill superpowers:receiving-code-review: confira cada item com rigor " +
      "técnico antes de agir, sem concordar por educação.",
    rules(),
    "",
    "Para cada item da lista fechada:",
    "- Bug dentro do escopo do PR (inclusive criado pela sua correção): corrija com commit e com teste que prove a correção.",
    "- Mudança fora do escopo ou feature nova: não faça; responda explicando.",
    "- Discorda: conteste só com prova (teste, regra escrita do repo, cenário com arquivo:linha). Contestação sem prova volta aberta.",
    "",
    "Lista fechada (responda cada um):",
    lines(todo, "nenhum item"),
    ...(waiting.length
      ? [
        "Dúvidas (o revisor humano pode decidir no painel; se você resolver, responda fixed com o commit, ou contested com a " +
          "explicação e a prova — o revisor confere):",
        lines(waiting, ""),
      ]
      : []),
    ...(suggestions.length
      ? [
        "Sugestões (não bloqueiam; aplique as que valem no escopo e responda cada uma: fixed com o commit, " +
          "contested ou wontfix com o motivo no reply):",
        lines(suggestions, ""),
      ]
      : []),
    "",
    REPORT_WHAT_YOU_FIND,
    "",
    "Depois de corrigir:",
    ...(opts.coauthorTrailer
      ? [`Em cada commit desta correção, termine a mensagem com esta linha (o crédito do co-autor no Git): ${opts.coauthorTrailer}`]
      : []),
    "1. Rode os testes do que você mexeu.",
    `2. Faça push na branch do PR: git push origin HEAD:${r.prBranch}`,
    "   Não use vibehub_deliver nesta revisão: o push é o git push acima, e o PR já existe. Se o push for recusado, " +
      `responda com o erro no reply e chame ${TOOL_RESPOND} mesmo assim.`,
    `3. Responda cada achado no PR: gh pr comment ${r.prNumber} --body "<id>: corrigido em <commit> / contestado porque <prova>"`,
    "4. Guarde o sha: git rev-parse HEAD",
    `5. No fim, chame a ferramenta MCP ${TOOL_RESPOND} com:`,
    `   card: "${r.cardId}"   (o $VIBEHUB_CARD_ID deste terminal)`,
    `   review: "${r.id}"`,
    `   round: ${r.round}`,
    "   headSha: o sha do passo 4 (40 caracteres)",
    "   items: [{ id, status: \"fixed\" | \"contested\" | \"wontfix\" (wontfix só em sugestão), commit?, reply }]",
    "   Não termine o turno sem chamar essa ferramenta: é ela que devolve a vez ao revisor.",
  ].join("\n");
}

/**
 * Uma pessoa escolheu, no painel, sugestões do revisor para o autor aplicar. Sugestão não bloqueia: o
 * autor aplica as que fazem sentido no escopo e diz por que não aplica as outras (`wontfix`). O push
 * depois do pronto volta a revisão ao revisor, que confere o que entrou.
 */
export function authorSuggestionsPrompt(r: Review, list: Finding[], opts: { by: string; coauthorTrailer?: string }): string {
  return [
    header(r),
    `${opts.by} pediu, no painel da revisão, que você aplique estas sugestões do revisor neste PR. Sugestão não bloqueia: ` +
      "aplique as que fazem sentido no escopo do PR; a que não fizer sentido, não aplique e diga por quê.",
    rules(),
    "",
    "Sugestões pedidas:",
    lines(list, ""),
    "",
    "Para cada uma:",
    "- Aplicou: commit, com teste do que mudou.",
    "- Não vai aplicar (fora do escopo, piora outra coisa, já resolvida): explique no reply.",
    REPORT_WHAT_YOU_FIND,
    ...(opts.coauthorTrailer
      ? [`Em cada commit, termine a mensagem com esta linha (o crédito do co-autor no Git): ${opts.coauthorTrailer}`]
      : []),
    "",
    "Depois:",
    "1. Rode os testes do que você mexeu.",
    `2. Faça push na branch do PR: git push origin HEAD:${r.prBranch}`,
    "3. Guarde o sha: git rev-parse HEAD",
    `4. Chame a ferramenta MCP ${TOOL_RESPOND} com:`,
    `   card: "${r.cardId}"   (o $VIBEHUB_CARD_ID deste terminal)`,
    `   review: "${r.id}"`,
    `   round: ${r.round}`,
    "   headSha: o sha do passo 3 (40 caracteres)",
    "   items: [{ id, status: \"fixed\" (com commit) | \"wontfix\" (reply com o motivo), commit?, reply }]",
    "   O push faz a revisão voltar ao revisor, que confere o que entrou: é o esperado. Nunca mergeie.",
  ].join("\n");
}

/** O aviso, no card do autor (o do revisor fica escondido do board), de dúvida esperando quem decide. */
export function authorQuestionNoticeText(r: Review, decider: string): string {
  const n = pendingQuestions(r.findings).length;
  return `PR #${r.prNumber}: ${n} ${n === 1 ? "dúvida" : "dúvidas"} esperando a decisão de ${decider} no painel da revisão`;
}

/** Pronto: o revisor aprova no GitHub. Aprovar não é mergear. */
export function reviewerApprovePrompt(r: Review): string {
  const risks = r.findings.filter((f) => f.status === "accepted_risk");
  return [
    header(r),
    "A revisão terminou sem bloqueante em aberto: o PR está pronto para o merge HUMANO.",
    rules(),
    "",
    `1. Aprove no GitHub, na sua conta: gh pr review ${r.prNumber} --approve --body "<resumo>"`,
    "   O resumo diz o que foi revisado, o que o autor corrigiu e as sugestões que ficaram.",
    ...(risks.length ? ["   Cite os riscos aceitos pelo revisor humano:", lines(risks, "")] : []),
    ghReviewFallback("vibehub_report"),
    "2. NÃO mergeie. Não rode `gh pr merge` e não chame vibehub_deliver: o merge é o botão do responsável no vibehub.",
    `3. No fim, chame a ferramenta MCP vibehub_report com card: "${r.reviewerCardId}", state: "ready", ` +
      `summary: "PR #${r.prNumber} aprovado no GitHub".`,
  ].join("\n");
}

/** A linha que abre o lembrete: o card terminou o turno sem a ferramenta que leva a rodada adiante. */
export function nudgePrefix(tool: typeof TOOL_SUBMIT | typeof TOOL_RESPOND): string {
  return (
    `Lembrete do vibehub: você terminou o turno sem chamar a ferramenta ${tool}. A revisão está parada esperando essa ` +
    "chamada. Faça o que faltou abaixo e chame a ferramenta antes de encerrar.\n\n"
  );
}

/**
 * A linha que vai na frente do delta quando o PR andou depois do `ready`: o revisor precisa saber que a
 * rodada nova não veio de uma resposta do autor à lista. `merge` = o merge humano foi recusado por
 * isso; `push` = o turno do autor terminou com um push novo (alguém mandou a IA dele mexer no PR).
 */
export function headMovedPrefix(r: Review, cause: "merge" | "push" = "merge"): string {
  const approved = r.reviewedSha ? ` (${r.reviewedSha.slice(0, 7)})` : "";
  const what = cause === "push"
    ? `O autor empurrou commits no PR #${r.prNumber} depois do pronto (push depois do pronto)`
    : `Merge recusado pelo vibehub: push depois do pronto. O head do PR #${r.prNumber} mudou`;
  return (
    `${what}: o head não é mais o commit que você aprovou${approved}, então a revisão voltou para a rodada ` +
    `${r.round}. Confira o que entrou desde então como uma rodada nova, pelos passos abaixo.\n\n`
  );
}

/** O aviso de mudança de fase, gravado no card do autor: PR, fase e o motivo numa linha. */
export function phaseNoticeText(r: Review): string {
  const at = `rodada ${r.round} de ${MAX_ROUNDS}`;
  switch (r.phase) {
    case "ready":
      return `PR #${r.prNumber}: revisão pronta (${at}) — sem bloqueante em aberto; o merge é do responsável.`;
    case "impasse":
      return `PR #${r.prNumber}: revisão em impasse (${at}) — ${impasseText(r.impasseReason)}.`;
    case "merged":
      return `PR #${r.prNumber}: mergeado em ${r.base}.`;
    default:
      return `PR #${r.prNumber}: revisão em ${r.phase} (${at}).`;
  }
}

/** O aviso de que o Approve não foi publicado: o PR está pronto, mas o GitHub ainda mostra o pedido de mudanças. */
export function approvePendingText(r: Review): string {
  return `PR #${r.prNumber}: Approve não publicado no GitHub — tente de novo pelo painel.`;
}

/** O aviso ao revisor humano de que a rodada deixou dúvida esperando a decisão dele no painel. */
export function questionNoticeText(r: Review): string {
  return `PR #${r.prNumber}: dúvida esperando sua decisão no painel`;
}

/** O motivo do impasse em palavras: "rodadas" é o código do modelo, o resto já vem escrito. */
export function impasseText(reason: string | undefined): string {
  if (reason === "rodadas") {
    return `${MAX_ROUNDS} rodadas com bloqueante aberto ou contestado; o revisor humano decide cada item travado`;
  }
  return oneLine(reason || "motivo não informado", 200);
}

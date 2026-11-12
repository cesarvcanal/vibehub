import { clipLine } from "../../utils/clipLine.js";
import { defuseUltraWords } from "../../utils/ultraWords.js";
import {
  autoMergeEligible, waivedText, MAX_ROUNDS, MERGE_GATE_AUTO_RETRIES, pendingImprovements, pendingQuestions, type Finding,
  type FindingStatus, type Review,
} from "./model.js";

/**
 * TEXTOS DA REVISÃO DE PR — o que o orquestrador digita no card do revisor e no do autor.
 *
 * Cada texto é AUTOSSUFICIENTE: o card que recebe não tem o contexto da revisão (o do revisor nasceu
 * agora; o do autor pode estar há dias em outra conversa). Por isso todos dizem, com todas as letras,
 * as quatro coisas que o loop precisa: que a IA só mergeia por ordem, a regra de bloqueio por prova, onde
 * estamos (revisão, PR, rodada N de 3) e qual ferramenta chamar no fim, com o `card` exato.
 *
 * O que veio da outra IA (títulos, respostas, provas) entra numa linha só e com teto: o texto viaja
 * por um heredoc até o tmux, e uma resposta de várias páginas não ajuda ninguém a decidir.
 *
 * Funções puras: a revisão entra, o texto sai.
 */

export const TOOL_SUBMIT = "vibehub_review_submit";
export const TOOL_RESPOND = "vibehub_review_respond";

/**
 * Um texto explicativo do achado (o problema, como resolver) com as quebras de linha preservadas e
 * indentadas sob o achado: é o que a pessoa leu no painel, e passos numerados achatados numa linha
 * perdiam o sentido. Teto alto, o mesmo do schema da ferramenta. PURE.
 */
function indentedBlock(text: string | undefined, indent: string, max = 2000): string {
  const t = String(text ?? "").replace(/\r/g, "").trim();
  const capped = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return capped.split("\n").map((l) => l.trimEnd()).filter((l, i, all) => l !== "" || (all[i - 1] ?? "") !== "").join(`\n${indent}`);
}

/**
 * O que a outra IA ou uma pessoa escreveu, como entra no texto digitado no card: numa linha (ou em
 * bloco) e com `ultrathink`/`ultracode` desarmados, que ali são citação, não pedido do turno. O molde
 * (branch, sha, comandos) não passa por aqui: desarmá-lo trocaria a branch do push. PURE.
 */
const quoted = (text: string | undefined, max = 300): string => defuseUltraWords(clipLine(text, max));
const quotedBlock = (text: string | undefined, indent: string, max?: number): string =>
  defuseUltraWords(indentedBlock(text, indent, max));

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
    "- Não mergeie o PR por conta própria. Se uma pessoa com papel na revisão (responsável, revisor, autor ou coautor) " +
      "mandar mergear NESTE card, mergeie: chame vibehub_deliver com card e from = o $VIBEHUB_CARD_ID deste terminal e " +
      "authorized: true. O vibehub só mergeia a revisão pronta, preso ao commit aprovado, e diz o motivo se recusar. " +
      "Nunca por `gh pr merge` nem pela API do GitHub.",
    "- Só bloqueia com prova: teste que falha, regra escrita do repo citada (arquivo e trecho), ou cenário concreto com " +
      "arquivo:linha. Bug no código deste PR (comportamento errado, falha, quebra, brecha de segurança, perda de dado, " +
      "regressão) TEM essa prova: é bloqueante e se resolve neste PR, nunca sugestão. Sugestão é só o que não é bug no " +
      "escopo (estilo, nome, refatoração, melhoria opcional, problema antigo fora do diff): aparece, não bloqueia, não abre rodada; " +
      "a melhoria que preserva o comportamento no código do PR é improvement, que o autor aplica sozinho.",
    // Medido nos transcripts das revisões do erp-aux (PRs #599, #605, #624, #627): a maior parte da rodada
    // ia em comando de 5 a 10 minutos (suíte inteira, `npm ci`, `tsc --force`), um atrás do outro.
    "- Teste por recorte: rode só os testes do que o PR tocou (o arquivo ou a pasta). A suíte inteira é do CI: confira " +
      "com `gh pr checks`. Comando que passaria de uns 3 minutos troca por um recorte menor.",
  ].join("\n");
}

const where = (f: Finding): string => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "");

function proofText(f: Finding): string {
  if (!f.proof) return "sem prova";
  const detail = f.proof.detail ? ` — ${quoted(f.proof.detail, 200)}` : "";
  return `${f.proof.kind} ${clipLine(f.proof.ref, 160)}${detail}`;
}

/** Um achado em uma linha de cabeçalho e uma de detalhes: o que é, onde, a prova e o que cada lado disse. */
function findingLine(f: Finding): string {
  const loc = where(f);
  const tags = [
    f.severity, STATUS_PT[f.status], f.humanDecision ? `decisão humana: ${f.humanDecision}` : "",
    f.requested ? `pedida ao autor por ${clipLine(f.requested.by, 60)}` : "",
  ].filter(Boolean);
  const head = `- ${f.id} [${tags.join(", ")}] ${quoted(f.title, 200)}${loc ? ` (${loc})` : ""}`;
  const parts = [`prova: ${proofText(f)}`];
  if (f.authorReply !== undefined) parts.push(`autor: "${quoted(f.authorReply)}"${f.commit ? ` (commit ${clipLine(f.commit, 60)})` : ""}`);
  if (f.reviewerReply !== undefined) parts.push(`revisor: "${quoted(f.reviewerReply)}"`);
  const blocks = [
    f.problem ? `\n    problema: ${quotedBlock(f.problem, "      ")}` : "",
    f.fix ? `\n    como resolver: ${quotedBlock(f.fix, "      ")}` : "",
  ].join("");
  return `${head}\n    ${parts.join("; ")}${blocks}`;
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

/**
 * QUEM AGE em cada achado, com as mesmas palavras para o revisor (que classifica) e para o autor (que
 * age): se cada lado lesse uma versão, o revisor mandaria como dúvida o que o autor corrigiria, e
 * vice-versa. O corte é o da autonomia corretiva do AGENTS.md §12: comportamento esperado claro, a IA
 * resolve; resolver exige decidir o que o sistema faz, uma pessoa decide. Os exemplos são do critério,
 * não uma lista fechada (pedido do César, 2026-11-12).
 */
const FINDING_CLASSES = [
  "Quem age em cada achado (o revisor classifica assim, e o autor age assim). A pergunta que separa: o comportamento " +
    "esperado está claro? Se está, a IA resolve sozinha, e decide COMO resolver. Se resolver exige decidir O QUE o sistema " +
    "deve fazer, uma pessoa decide. Autonomia técnica não é autonomia de produto.",
  "- blocking — a IA do autor corrige sem perguntar: bug, erro de lógica, inconsistência, validação ausente, comportamento " +
    "que contraria o que o PR quis fazer, contradição com uma solução evidente. Precisa de prova (regras acima).",
  "- improvement — a IA do autor aplica sozinha, na mesma rodada: melhoria técnica válida no código que o PR já mexe, que " +
    "preserva a regra de negócio, a intenção e o comportamento esperado (simplificar, tirar duplicação, deixar mais claro " +
    "ou mais seguro o que o PR escreveu). file obrigatório, num arquivo que o PR altera. Não amplia escopo: se aplicar " +
    "exigiria mexer fora do PR, mudar comportamento ou contrato, não é improvement.",
  "- question — espera a decisão de uma pessoa, e só quando resolver exige decidir intenção ou produto: intenção ambígua; " +
    "mudar regra de negócio ou o comportamento esperado; mudar arquitetura ou estrutura de forma relevante; fugir do padrão " +
    "estabelecido do repo; caminhos razoáveis com impactos diferentes e nenhum tecnicamente evidente; ou o PR altera algo " +
    "que já funcionava sem deixar claro que era a intenção, ou pode colidir com uma funcionalidade existente. Em problem, " +
    "o conflito; em fix, as alternativas e o que cada uma causa. Dúvida não é saída fácil: erro comprovado com uma solução " +
    "coerente com o que foi pedido é blocking.",
  "- suggestion — opcional, uma pessoa escolhe no painel: o que não é preciso para corrigir nada e não justifica mudança " +
    "automática (estilo, nome, refatoração maior, volta desnecessária, o que fica fora do escopo do PR, problema antigo " +
    "fora do diff).",
  "Os exemplos ilustram o critério; não são uma lista fechada.",
].join("\n");

const FINDING_FIELDS =
  "findings: [{ severity: \"blocking\" | \"improvement\" | \"suggestion\" | \"question\" | \"refuted\", title, problem, file?, line?, " +
  "proof?: { kind: \"failing_test\" | \"rule\" | \"scenario\", ref, detail? }, fix }]";

function classification(): string {
  return [
    "Classifique cada achado:",
    FINDING_CLASSES,
    "",
    "Em detalhe:",
    "- blocking: SÓ com prova. proof.kind = failing_test (ref = o teste que falha, ex. src/x.test.ts:12), rule (ref = a regra " +
      "escrita do repo, ex. CLAUDE.md, com o trecho em detail) ou scenario (ref = arquivo:linha, detail = o cenário concreto " +
      "que quebra, inclusive funcionalidade que já existia). Bloqueante sem prova vira sugestão no servidor.",
    "- suggestion: SÓ o que não é bug no escopo do PR: estilo, nome, legibilidade, refatoração, melhoria opcional, volta " +
      "desnecessária, o que fica fora do escopo do PR, ou problema que já existia fora do que o PR mexe. Bug ou incongruência " +
      "no que o PR fez não é sugestão: é blocking com proof.kind = scenario (ref = arquivo:linha, detail = o caso que dá " +
      "errado). Na dúvida entre os dois, e o defeito é real e alcançável, é blocking.",
    "- improvement: o autor aplica na rodada seguinte e você confere; na última rodada ela fica só registrada. Nunca segura o merge.",
    "- question: fica esperando decisão: o revisor humano decide no painel, ou o autor resolve/explica e você confere na " +
      "rodada seguinte. O ciclo segue com o resto.",
    "- refuted: achado que a verificação derrubou (fica só no histórico).",
    "",
    "Escreva cada achado para uma pessoa que vai decidir pelo painel, sem abrir o código:",
    "- title: um rótulo curto, uma linha.",
    "- problem: o problema em português claro, 2 a 4 frases: o que está errado, em que situação aparece e o que " +
      "acontece se ficar assim (quem é afetado, o que quebra ou piora). Nada de jargão solto nem só o nome da função.",
    "- fix: como resolver, de forma concreta: o que mudar, em qual arquivo/função e o resultado esperado — o bastante " +
      "para a IA do autor aplicar sem adivinhar. Obrigatório em todo blocking, improvement e suggestion.",
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
  return "Você é o REVISOR deste PR. Não escreva no código do autor: não faça commit, não faça push. vibehub_deliver aqui só serve para o merge por ordem (regras abaixo).";
}

/** Rodada 1: revisão completa do PR com o /code-review, publicada no GitHub e entregue estruturada. */
export function reviewerRoundPrompt(r: Review): string {
  return [
    header(r),
    reviewerIdentity(),
    rules(),
    "",
    "1. Ponha o worktree na cabeça do PR:",
    `   git fetch origin && git reset --hard origin/${r.prBranch}`,
    "   e guarde o sha: git rev-parse HEAD",
    `2. Rode /code-review high no PR #${r.prNumber} (com a etapa de verificação que tenta derrubar cada achado).`,
    `3. ${classification()}`,
    "4. Publique a rodada no GitHub, na sua conta, com a lista (severidade, arquivo:linha, problema, prova, como resolver):",
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
export function reviewerDeltaPrompt(r: Review): string {
  const judged = r.findings.filter(underReview);
  const humanBlocked = judged.filter((f) => f.humanDecision === "block" || f.humanDecision === "keep");
  const waiting = pendingQuestions(r.findings);
  // As sugestões em aberto, e as que o autor respondeu depois da última fala do revisor (ele ainda não conferiu).
  const answered = answeredSinceReviewer(r);
  // Dúvida que o autor respondeu (resolvida ou explicada) e nenhum humano decidiu: o revisor confere.
  const answeredDoubts = r.findings.filter((f) => f.severity === "question" && !f.humanDecision && answered.has(f.id));
  const stillWaiting = waiting.filter((f) => !answered.has(f.id));
  const suggestions = r.findings.filter((f) => f.severity === "suggestion" && (f.status === "open" || answered.has(f.id)));
  const improvements = r.findings.filter((f) => f.severity === "improvement" && answered.has(f.id));
  const since = r.reviewedSha
    ? `git diff ${r.reviewedSha}..HEAD`
    : "o PR inteiro (não há sha da rodada anterior)";
  return [
    header(r),
    reviewerIdentity(),
    "O autor respondeu à lista da rodada anterior e empurrou as correções.",
    rules(),
    "",
    FINDING_CLASSES,
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
    ...(improvements.length
      ? [
        "   Melhorias que o autor respondeu: fixed se aplicou de verdade, sem sair do escopo; open se disse que aplicou e " +
          "não aplicou; dropped se aceita o motivo do wontfix. Se a melhoria saiu do escopo do PR ou mudou comportamento: " +
          `achado novo blocking com introducedInRound: ${r.round}.`,
        lines(improvements, ""),
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
 * Autonomia corretiva (AGENTS.md §12): o que quebra o que o PR quis fazer se corrige sem perguntar; o
 * que amplia escopo não se faz; dúvida de intenção é da pessoa, não da IA.
 */
const CORRECTIVE_AUTONOMY = [
  "- Bug ou incongruência no que o PR fez: corrija sem perguntar, com commit e teste, mesmo que tenha vindo como sugestão.",
  "- Melhoria autônoma (improvement): aplique sem esperar ninguém, só o que o item descreve e só nos arquivos que o PR já " +
    "altera, sem mudar regra, contrato ou comportamento. Se aplicar exigir sair disso, não aplique: wontfix com o motivo.",
  "- Fora do escopo, feature nova, volta desnecessária ou mudança de uma decisão intencional: não faça; responda explicando.",
  "- Você decide COMO resolver, não O QUE o sistema deve fazer. Correção que exige decidir a intenção do PR, muda regra de " +
    "negócio ou comportamento esperado, ou altera algo que já funcionava e pode colidir com outra funcionalidade sem estar " +
    "claro que era a intenção: não aplique; responda com a dúvida sobre a intenção e as consequências de cada caminho, para " +
    "a pessoa decidir no painel.",
];

/**
 * A lista fechada para o autor: corrigir o que é bug no escopo, contestar só com prova. Com co-autor
 * na revisão, `coauthorTrailer` é a linha `Co-authored-by: Nome <email>` que dá a ele o crédito no Git.
 */
export function authorFixPrompt(r: Review, opts: { coauthorTrailer?: string } = {}): string {
  const todo = r.findings.filter(actionableForAuthor);
  const waiting = pendingQuestions(r.findings);
  const suggestions = r.findings.filter((f) => f.severity === "suggestion" && f.status === "open");
  const improvements = pendingImprovements(r.findings);
  return [
    header(r),
    "O revisor encontrou problemas no seu PR. Siga a skill superpowers:receiving-code-review: confira cada item com rigor " +
      "técnico antes de agir, sem concordar por educação.",
    rules(),
    "",
    FINDING_CLASSES,
    "",
    "Para cada item da lista fechada:",
    "- Bug dentro do escopo do PR (inclusive criado pela sua correção): corrija com commit e com teste que prove a correção.",
    "- Discorda: conteste só com prova (teste, regra escrita do repo, cenário com arquivo:linha). Contestação sem prova volta aberta.",
    ...CORRECTIVE_AUTONOMY,
    "",
    "Lista fechada (responda cada um):",
    lines(todo, "nenhum item"),
    ...(improvements.length
      ? [
        "Melhorias autônomas (aplique agora, sem esperar ninguém; responda TODAS: fixed com o commit, ou wontfix com o motivo):",
        lines(improvements, ""),
      ]
      : []),
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
    "Depois de corrigir:",
    ...(opts.coauthorTrailer
      ? [`Em cada commit desta correção, termine a mensagem com esta linha (o crédito do co-autor no Git): ${opts.coauthorTrailer}`]
      : []),
    "1. Rode os testes do que você mexeu.",
    `2. Faça push na branch do PR: git push origin HEAD:${r.prBranch}`,
    "   O push desta correção é o git push acima, não o vibehub_deliver: o PR já existe. Se o push for recusado, " +
      `responda com o erro no reply e chame ${TOOL_RESPOND} mesmo assim.`,
    `3. Responda cada achado no PR: gh pr comment ${r.prNumber} --body "<id>: corrigido em <commit> / contestado porque <prova>"`,
    "4. Guarde o sha: git rev-parse HEAD",
    `5. No fim, chame a ferramenta MCP ${TOOL_RESPOND} com:`,
    `   card: "${r.cardId}"   (o $VIBEHUB_CARD_ID deste terminal)`,
    `   review: "${r.id}"`,
    `   round: ${r.round}`,
    "   headSha: o sha do passo 4 (40 caracteres)",
    "   items: [{ id, status: \"fixed\" | \"contested\" | \"wontfix\" (wontfix só em sugestão e melhoria), commit?, reply }]",
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
    FINDING_CLASSES,
    "",
    "Sugestões pedidas:",
    lines(list, ""),
    "",
    "Para cada uma:",
    "- Cada sugestão traz o problema e como resolver: siga a proposta, ou resolva o mesmo problema de outro jeito melhor.",
    ...CORRECTIVE_AUTONOMY,
    "- Aplicou: commit, com teste do que mudou.",
    "- Não vai aplicar (fora do escopo, piora outra coisa, já resolvida, dúvida de intenção): explique no reply.",
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
    "   Responda TODAS as sugestões pedidas nesta mesma chamada: a que ficar de fora faz a ferramenta recusar a resposta.",
    "   O push faz a revisão voltar ao revisor, que confere o que entrou: é o esperado. Não mergeie por conta própria.",
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
    autoMergeEligible(r)
      ? `A revisão terminou ${waivedText(r) ? `sem bloqueante (${waivedText(r)})` : "sem nada em aberto"}: depois do seu Approve, o PAINEL mergeia sozinho (não você).`
      : "A revisão terminou sem bloqueante em aberto: o PR está pronto para o merge HUMANO.",
    rules(),
    "",
    `1. Aprove no GitHub, na sua conta: gh pr review ${r.prNumber} --approve --body "<resumo>"`,
    "   O resumo diz o que foi revisado, o que o autor corrigiu e as sugestões que ficaram.",
    ...(risks.length ? ["   Cite os riscos aceitos pelo revisor humano:", lines(risks, "")] : []),
    ghReviewFallback("vibehub_report"),
    autoMergeEligible(r)
      ? "2. Não mergeie por conta própria: o merge sai do vibehub quando você reportar o passo 3."
      : "2. Não mergeie por conta própria: o merge é o botão do responsável no vibehub, ou seu se alguém com papel na revisão mandar (regras acima).",
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
      return autoMergeEligible(r)
        ? `PR #${r.prNumber}: revisão pronta (${at}) — ${waivedText(r) ?? "nada em aberto"}; o merge sai sozinho.`
        : `PR #${r.prNumber}: revisão pronta (${at}) — sem bloqueante em aberto; o merge é do responsável.`;
    case "impasse":
      return `PR #${r.prNumber}: revisão em impasse (${at}) — ${impasseText(r.impasseReason)}.`;
    case "merged":
      return `PR #${r.prNumber}: mergeado em ${r.base}.`;
    default:
      return `PR #${r.prNumber}: revisão em ${r.phase} (${at}).`;
  }
}

/** O aviso, nos dois cards, de que o gate do merge falhou no commit aprovado. */
export function mergeGateFailedText(r: Review): string {
  if (r.mergeGate?.exhausted) {
    return `PR #${r.prNumber}: os testes do merge seguem falhando depois de rodarem de novo sozinhos ${MERGE_GATE_AUTO_RETRIES} vezes — ` +
      "o merge espera alguém conferir e clicar em \"Tentar de novo\".";
  }
  return `PR #${r.prNumber}: os testes do merge falharam no commit aprovado — a IA do autor está corrigindo, e eles rodam de novo sozinhos.`;
}

/**
 * O gate do merge falhou no commit aprovado: o autor recebe a saída e conserta. Quase sempre é a
 * worktree (dependência não instalada) ou um teste instável sob carga, não o código revisado; o texto
 * diz isso para a IA não sair caçando bug no diff.
 */
export function authorMergeGatePrompt(r: Review): string {
  return [
    header(r),
    "A revisão aprovou o PR, mas os testes que o merge roda (o gate: CI do PR, ou os testes desta worktree) " +
      `falharam no commit aprovado (${(r.reviewedSha ?? "").slice(0, 7)}). Enquanto estiverem vermelhos, o merge não sai.`,
    rules(),
    "",
    "Saída do gate:",
    quotedBlock(r.mergeGate?.output, "  ", 4000),
    "",
    "O que fazer:",
    "1. Leia a causa. Dependência faltando ou comando não encontrado é a worktree: rode npm install (na raiz e nos " +
      "pacotes que pedirem). Nada a commitar nesse caso.",
    "2. Teste que falhou de verdade: corrija, com commit e teste. Teste de tempo que estoura sob carga: torne-o " +
      "robusto (sem depender do relógio da máquina), não só aumente o limite.",
    "3. Rode de novo os testes que falharam até passarem.",
    `4. Se houve commit: git push origin HEAD:${r.prBranch} (a revisão volta ao revisor conferir o que entrou, é o esperado).`,
    "   Sem commit (só instalar): nada a empurrar. Ao fim do seu turno o vibehub roda o gate de novo sozinho.",
  ].join("\n");
}

/** O aviso de que o merge automático não saiu: o motivo, e que o botão segue valendo. */
export function autoMergeFailedText(r: Review, why: string): string {
  return `PR #${r.prNumber}: o merge automático não saiu (${clipLine(why, 200)}) — mergeie pelo painel.`;
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
  return clipLine(reason || "motivo não informado", 200);
}

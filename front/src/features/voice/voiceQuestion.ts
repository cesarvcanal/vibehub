import type { SdkQuestion, SdkQuestionAnswer, SdkRow } from "@/features/board/lib/sdkChat";
import { CONTEXT_MAX_CHARS } from "./liveVoice";
import type { VoiceTurn } from "./voiceTurns";

export const QUESTION_ANSWER_SENT =
  "A escolha da pessoa foi entregue ao agente do card como resposta da pergunta dele, e ele segue o trabalho. " +
  "Não invente o resultado: ele chega como atualização desta tarefa.";

export type OpenQuestion = Extract<SdkRow, { kind: "question" }>;

export function openQuestion(rows: readonly SdkRow[]): OpenQuestion | null {
  return rows.findLast((row): row is OpenQuestion => row.kind === "question" && row.outcome === "pending") ?? null;
}

export function questionForVoice(questions: readonly SdkQuestion[]): string {
  const howToAnswer =
    "O agente do card parou para fazer uma pergunta à pessoa e espera a resposta. Leia a pergunta e as opções para a pessoa, " +
    "diga qual é a recomendada (a opção marcada como recomendada, se houver) e pergunte qual ela escolhe. " +
    "Quando ela escolher, passe a escolha ao agente: ela vai como resposta desta pergunta.";
  const askedWith = (withDescriptions: boolean): string[] =>
    questions.map((item) => {
      const options = item.options.map((option, index) =>
        `${index + 1}) ${option.label}${withDescriptions && option.description ? ` — ${option.description}` : ""}`,
      );
      const choice = item.multiSelect ? "Pode escolher mais de uma opção." : "Escolha uma opção.";
      return `«${item.question}» ${choice} Opções: ${options.join("; ")}.`;
    });
  const full = [howToAnswer, ...askedWith(true)].join(" ");
  return full.length <= CONTEXT_MAX_CHARS ? full : [howToAnswer, ...askedWith(false)].join(" ");
}

export function voiceAnswers(questions: readonly SdkQuestion[], turns: VoiceTurn[]): SdkQuestionAnswer[] | null {
  const saidAt = turns.findLastIndex((turn) => turn.role === "user" && turn.text.trim() !== "");
  if (saidAt < 0) return null;
  const said = `[resposta por voz] ${turns[saidAt]!.text.replace(/\s+/g, " ").trim()}`;
  const voiceBefore = turns.slice(0, saidAt).findLast((turn) => turn.role === "assistant" && turn.text.trim() !== "");
  const explained = [
    said,
    ...(voiceBefore ? [`A voz tinha acabado de dizer: «${voiceBefore.text.replace(/\s+/g, " ").trim()}»`] : []),
    "Se a fala não escolhe uma das opções, é um pedido novo da pessoa: atenda-o.",
  ].join("\n\n");
  return questions.map((_, index) => ({ selected: [index === 0 ? explained : said] }));
}

/**
 * O QUE DIZER ENQUANTO O TURNO CORRE — o verbo e a nota de estado do indicador de trabalho.
 *
 * O problema: "Trabalhando…" é a MESMA palavra no segundo 2 e no minuto 9. Quem olha a tela não
 * sabe se o agente está pensando, rodando uma ferramenta ou travado — e foi essa a reclamação: sem
 * retorno visual, um turno longo parece uma tela morta. O terminal do Claude Code resolve isso com
 * duas peças: um verbo que MUDA (a prova de que a coisa está viva) e uma cauda que ESCALA com o
 * tempo ("thinking" → "still thinking"), ao lado do relógio.
 *
 * Aqui é a mesma ideia, e é PURA: entra o que está acontecendo e há quantos segundos, saem as
 * CHAVES de i18n. Nada de Date.now(), nada de random — o mesmo segundo dá sempre a mesma frase, e
 * o teste roda sem relógio nem idioma.
 */

/** O que o turno está fazendo agora, na granularidade que o indicador sabe nomear. */
export type WorkingKind = "preparing" | "thinking" | "answering" | "tool" | "working";

export interface WorkingStage {
  /** Chave do verbo (o que aparece no lugar do antigo "Trabalhando…"). */
  verb: string;
  /** Chave da nota de estado, a cauda que vai junto do relógio ("ainda pensando"). */
  note: string;
}

/**
 * De quanto em quanto tempo o verbo troca. Curto demais vira pisca-pisca; longo demais volta a
 * parecer congelado. 12s deixa a troca acontecer duas vezes antes da primeira escalada da nota.
 */
export const VERB_ROTATE_SECONDS = 12;
/** A partir daqui a nota vira "ainda …" — o turno deixou de ser rápido. */
export const STILL_AFTER_SECONDS = 20;
/** E a partir daqui vira "há bastante tempo" — é longo mesmo, e dizer isso é honesto. */
export const LONG_AFTER_SECONDS = 90;

/**
 * Os verbos de cada fase, na ordem em que se revezam. Uma fase com um verbo só (preparar) nunca
 * troca: inventar sinônimo pra uma espera de boot não informa nada.
 */
const VERBS: Record<WorkingKind, readonly string[]> = {
  preparing: ["sdk.preparing"],
  thinking: ["sdk.verb.thinking", "sdk.verb.reasoning", "sdk.verb.pondering"],
  answering: ["sdk.verb.answering", "sdk.verb.writing"],
  tool: ["sdk.verb.running", "sdk.verb.working"],
  working: ["sdk.verb.working", "sdk.verb.running"],
};

/**
 * O verbo e a nota deste instante. `seconds` negativo ou quebrado é tratado como 0 (o relógio da
 * view é inteiro, mas esta função não depende disso). PURE, TOTAL.
 */
export function workingStage(kind: WorkingKind, seconds: number): WorkingStage {
  const elapsed = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const verbs = VERBS[kind];
  const verb = verbs[Math.floor(elapsed / VERB_ROTATE_SECONDS) % verbs.length] as string;
  const stage = elapsed >= LONG_AFTER_SECONDS ? "Long" : elapsed >= STILL_AFTER_SECONDS ? "Still" : "";
  return { verb, note: `sdk.note.${kind}${stage}` };
}

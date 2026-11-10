/**
 * Desarma `ultrathink` e `ultracode` num texto que o vibehub digita num card em nome de outro: o Claude
 * Code lê as duas como PEDIDO do turno onde aparecem, citadas ou não. Texto repassado (a fala da outra
 * IA numa revisão, o comando que a retomada cita) não pede nada; só a pessoa pede.
 *
 * Cicatrizes: no PR #259 (que mexia justamente nelas) a resposta do autor citou a palavra, o revisor
 * subiu a max com orquestração multiagente e cada rodada de delta virou um Workflow de 12 a 14 minutos;
 * e a retomada pós-deploy que citava um comando com a palavra pôs o turno em esforço máximo.
 *
 * Só quebra a palavra onde o detector a reconhece (as fronteiras de `findKeyword` em
 * front/src/features/board/lib/ultraWords.ts): caminho, flag e branch (`src/x.ts`, `--x-y`,
 * `card/suporte-...-ab12`) não são pedido e ficam como estão. Mesmo assim, aplique só ao texto livre,
 * nunca a um comando montado. O hífen quebra a palavra e a IA ainda lê o que é. PURE.
 */
const ULTRA_WORD_RE = /(?<![/\\-])\b(ultra)(think|code)\b(?![/\\\-?]|\.[\p{L}\p{N}_])/giu;

export function defuseUltraWords(text: string): string {
  return text.replace(ULTRA_WORD_RE, "$1-$2");
}

/**
 * A lista de comandos interrompidos que a retomada cita, desarmada. Se algum comando mudou, a lista
 * diz isso: a IA que rodar a linha de novo tira o hífen em vez de rodar outro filtro. PURE.
 */
export function defusedCommandList(commands: readonly string[]): string {
  const lines = commands.map((c) => `- ${defuseUltraWords(c)}`);
  const changed = lines.some((l, i) => l !== `- ${commands[i]}`);
  if (changed) lines.push("(palavras reservadas quebradas com hífen nesta lista; o comando original não tem o hífen)");
  return lines.join("\n");
}

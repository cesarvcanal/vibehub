/**
 * Desarma `ultrathink` e `ultracode` num texto que o vibehub digita num card em nome de outro: o Claude
 * Code lê as duas como PEDIDO do turno onde aparecem, citadas ou não. Texto repassado (a fala da outra
 * IA numa revisão, o comando que a retomada cita) não pede nada; só a pessoa pede.
 *
 * Cicatrizes: no PR #259 (que mexia justamente nelas) a resposta do autor citou "mantém o ultracode", o
 * revisor subiu a max com orquestração multiagente e cada rodada de delta virou um Workflow de 12 a 14
 * minutos; e a retomada pós-deploy que citava um comando com a palavra pôs o turno em ultrathink.
 * O hífen quebra a palavra e a IA ainda lê o que é. PURE.
 */
export function defuseUltraWords(text: string): string {
  return text.replace(/(ultra)(think|code)/gi, "$1-$2");
}

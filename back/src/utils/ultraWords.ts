/**
 * Defuses `ultrathink` and `ultracode` in a text vibehub types into a card on someone else's behalf: Claude
 * Code reads both as a REQUEST of the turn they appear in, quoted or not. Relayed text (the other AI's
 * message in a review, the command the resume quotes) requests nothing; only the person requests.
 *
 * Scars: in PR #259 (which touched precisely them) the author's answer quoted the word, the reviewer went
 * up to max with multi-agent orchestration and each delta round turned into a 12-to-14-minute Workflow;
 * and the post-deploy resume that quoted a command containing the word put the turn on maximum effort.
 *
 * It only breaks the word where the detector recognises it (the boundaries of `findKeyword` in
 * front/src/features/board/lib/ultraWords.ts): path, flag and branch (`src/x.ts`, `--x-y`,
 * `card/suporte-...-ab12`) are not a request and stay as they are. Even so, apply it only to free text,
 * never to an assembled command. The hyphen breaks the word and the AI still reads what it is. PURE.
 */
const ULTRA_WORD_RE = /(?<![/\\-])\b(ultra)(think|code)\b(?![/\\\-?]|\.[\p{L}\p{N}_])/giu;

export function defuseUltraWords(text: string): string {
  return text.replace(ULTRA_WORD_RE, "$1-$2");
}

/**
 * The list of interrupted commands the resume quotes, defused. If any command changed, the list says so:
 * the AI that runs the line again removes the hyphen instead of running another filter. PURE.
 */
export function defusedCommandList(commands: readonly string[]): string {
  const lines = commands.map((c) => `- ${defuseUltraWords(c)}`);
  const changed = lines.some((l, i) => l !== `- ${commands[i]}`);
  if (changed) lines.push("(palavras reservadas quebradas com hífen nesta lista; o comando original não tem o hífen)");
  return lines.join("\n");
}

/**
 * THE "/" MENU — the rules behind invoking a skill or a command from the chat field.
 *
 * The card's session already knows every skill, plugin command, project command and built-in it
 * can run (the back forwards the CLI's own catalogue — see `back/src/services/sdk/protocol.ts`).
 * What was missing was a way to REACH them from the panel: in the terminal you press "/" and the
 * TUI offers the list; in the chat you had to know the name by heart and type it blind.
 *
 * Everything here is pure — when the menu opens, what it offers for what you typed, and what the
 * field looks like after you pick. The component owns the keyboard and the pixels, nothing else.
 */

/** One invocable command (mirror of `SlashCommandInfo` in the back's protocol). */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  source: "skill" | "plugin" | "command";
}

/** How many entries the menu shows at once — enough to scan, short enough not to be a page. */
export const SLASH_MENU_LIMIT = 8;

/**
 * Is the field currently WRITING a command name, and which prefix?
 *
 * Only while the whole draft is one word starting with "/" — `/co`, `/code-review`. The moment a
 * space is typed the name is settled and what follows is the command's ARGUMENTS, so the menu gets
 * out of the way (`/code-review high` must not reopen it). Returns the typed prefix without the
 * slash (`""` right after "/", which is how the menu opens showing everything), or null. PURE.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([a-zA-Z0-9._:-]*)$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

/** Case/accent-insensitive haystack for matching. PURE. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Score one command against the typed prefix. Higher is better, 0 means "do not show".
 *
 * The ranking is what makes a 40-command list usable: the name you are typing first, then names
 * that merely contain it, then the ones whose DESCRIPTION does — that last rung is the point of
 * searching by description at all ("bug" finding `/debug` is obvious, but it should also find the
 * skill whose description says it hunts bugs). A command's aliases match like its name. PURE.
 */
export function scoreSlashCommand(command: SlashCommandInfo, query: string): number {
  const q = fold(query);
  if (q === "") return 1; // an empty query lists everything, in catalogue order
  const names = [command.name, ...(command.aliases ?? [])].map(fold);
  let best = 0;
  for (const name of names) {
    if (name === q) best = Math.max(best, 100);
    else if (name.startsWith(q)) best = Math.max(best, 80);
    else if (name.includes(q)) best = Math.max(best, 60);
    else if (name.split(/[.:_-]/).some((part) => part.startsWith(q))) best = Math.max(best, 50);
  }
  if (best > 0) return best;
  return fold(command.description ?? "").includes(q) ? 20 : 0;
}

/**
 * The entries the menu shows for what is typed, best first and capped. Ties keep the catalogue's
 * own order (skills before built-ins, as the CLI lists them) rather than re-sorting by name — the
 * order the session reports is meaningful. PURE.
 */
export function filterSlashCommands(
  commands: SlashCommandInfo[],
  query: string,
  limit = SLASH_MENU_LIMIT,
): SlashCommandInfo[] {
  return commands
    .map((command, index) => ({ command, index, score: scoreSlashCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .map((entry) => entry.command);
}

/**
 * The field after picking an entry: the command, and a trailing space so the caret sits where the
 * arguments go. A command that takes no arguments is left ready to send as it is — the space is
 * harmless (the CLI trims it) and typing over it is how you keep going. PURE.
 */
export function applySlashPick(command: SlashCommandInfo): string {
  return `/${command.name} `;
}

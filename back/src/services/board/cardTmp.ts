export const CARD_TMP_ROOT = "/tmp/vibehub";

export function cardTmpDir(cardId: string): string {
  return `${CARD_TMP_ROOT}/${cardId}`;
}

export function cardTmpEnv(cardId: string): Array<[string, string]> {
  const dir = cardTmpDir(cardId);
  // CLAUDE_CODE_TMPDIR: Claude Code's documented temp-root override (task outputs), checked on 2.1.328.
  return ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"].map((name) => [name, dir]);
}

export const CREATE_CARD_TMPDIR = 'mkdir -p "$TMPDIR" 2>/dev/null; ';

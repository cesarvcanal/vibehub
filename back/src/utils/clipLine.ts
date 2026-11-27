/**
 * A text as ONE line with a ceiling: whitespace runs (newlines included) collapse to a space, and a
 * text longer than `max` is cut to `max - 1` characters plus "…". Absent text is the empty line. PURE.
 */
export function clipLine(text: string | undefined, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const cutEndsInsideCharacter = /[\uD800-\uDBFF]$/.test(cut);
  return `${cutEndsInsideCharacter ? cut.slice(0, -1) : cut}…`;
}

/**
 * A text as ONE line with a ceiling: whitespace runs (newlines included) collapse to a space, and a
 * text longer than `max` is cut to `max - 1` characters plus "…". Absent text is the empty line. PURE.
 */
export function clipLine(text: string | undefined, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

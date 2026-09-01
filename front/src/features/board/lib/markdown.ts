/**
 * The smallest markdown that makes an agent's answer readable — and nothing else.
 *
 * Claude writes fenced code, headings, bullets, `inline code`, **bold** and bare URLs, so those six
 * are what this understands. Everything else stays literal text, which is the safe failure: an
 * unrendered asterisk is a blemish, a half-implemented parser that eats a line of a diff is a lie.
 *
 * No dependency, on purpose: a markdown library is bigger than this whole view, and it would arrive
 * with an HTML sanitiser to configure. Nothing here ever produces HTML — the caller renders React
 * nodes from these tokens, so there is no injection surface to get wrong.
 */

export type MdBlock =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "paragraph"; text: string };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

/**
 * Splits a message into blocks. Inside a fence NOTHING is interpreted — that is the whole point of
 * a fence, and a `# comment` in a shell snippet is not a heading. PURE.
 */
export function mdBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const flushBullets = (): void => {
    if (bullets.length) blocks.push({ type: "bullets", items: bullets });
    bullets = [];
  };
  const flush = (): void => {
    flushParagraph();
    flushBullets();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    const fence = FENCE.exec(raw);
    if (fence) {
      flush();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      // An UNCLOSED fence still renders as code: the message may be arriving, or Claude may simply
      // have forgotten the closing line, and dropping the block would hide the answer.
      for (; i < lines.length && !FENCE.test(lines[i] as string); i += 1) body.push(lines[i] as string);
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: (heading[1] as string).length, text: heading[2] ?? "" });
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1] as string);
      continue;
    }

    if (!raw.trim()) {
      flush();
      continue;
    }
    flushBullets();
    paragraph.push(raw);
  }
  flush();
  return blocks;
}

export type MdToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; value: string }
  | { type: "link"; value: string };

/**
 * What counts as a clickable link, everywhere a chat message is rendered:
 *  - absolute http(s) URLs (trailing sentence punctuation stays out of the link);
 *  - the panel's own RELATIVE preview paths (`/preview/<port>/…`) — the `vibehub_preview` tool
 *    answers with the path on purpose (it works on every host the panel is reached through), and a
 *    link the agent hands the user must be a link, not text to copy.
 * ONLY these two shapes ever become an href, which is the whole sanitisation story: `javascript:`,
 * `data:` or any other scheme simply never matches, so it can never leave as anything but text.
 */
const LINK_SOURCE = "https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?]|\\/preview\\/\\d{1,5}\\/(?:[^\\s<>()]*[^\\s<>().,;:!?])?";

/**
 * Bare linkification for PLAIN text (a user's own message): only text and link tokens, nothing of
 * markdown is interpreted — a user's asterisks are their asterisks. PURE, TOTAL.
 */
export function linkifyTokens(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  const pattern = new RegExp(`(${LINK_SOURCE})`, "g");
  let last = 0;
  const source = String(text ?? "");
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    if (m.index > last) tokens.push({ type: "text", value: source.slice(last, m.index) });
    tokens.push({ type: "link", value: m[1] as string });
    last = m.index + m[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
  return tokens;
}

/** `code`, **bold** and bare URLs/preview paths, in the order they appear. Everything else is text. PURE. */
export function mdInline(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  const pattern = new RegExp(`\`([^\`\\n]+)\`|\\*\\*([^*\\n]+)\\*\\*|(${LINK_SOURCE})`, "g");
  let last = 0;
  const source = String(text ?? "");
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    if (m.index > last) tokens.push({ type: "text", value: source.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: "code", value: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: "strong", value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: "link", value: m[3] });
    last = m.index + m[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
  return tokens;
}

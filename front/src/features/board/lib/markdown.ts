/**
 * The markdown layer of a chat message.
 *
 * Two different jobs live here, and keeping them apart is the point:
 *
 *  - An AGENT'S answer is markdown, and is parsed by `react-markdown` + `remark-gfm` (see
 *    `ChatView.tsx`). GFM is not optional for us: Claude writes tables, `~~strike~~` and bare
 *    links constantly, and plain CommonMark renders a table as a paragraph with `|---|---|` in it.
 *  - A USER'S message is NOT markdown. Their asterisks are their asterisks. All it gets is
 *    `linkifyTokens` below, which turns the two link shapes we trust into hrefs and nothing else.
 *
 * Nothing in the chat ever reaches `dangerouslySetInnerHTML`. react-markdown renders React nodes,
 * raw HTML in the source is neutralised by `remarkEscapeHtml`, and every href is filtered through
 * `safeUrl` — an allowlist, so an unknown scheme is never a link by accident.
 */

/**
 * What counts as a clickable link, everywhere a chat message is rendered:
 *  - absolute http(s) URLs (trailing sentence punctuation stays out of the link);
 *  - the panel's own RELATIVE preview paths (`/preview/<port>/…`) — the `vibehub_preview` tool
 *    answers with the path on purpose (it works on every host the panel is reached through), and a
 *    link the agent hands the user must be a link, not text to copy.
 * ONLY these two shapes ever become an href, which is the whole sanitisation story: `javascript:`,
 * `data:` or any other scheme simply never matches, so it can never leave as anything but text.
 */
const PREVIEW_SOURCE = "\\/preview\\/\\d{1,5}\\/(?:[^\\s<>()]*[^\\s<>().,;:!?])?";
const LINK_SOURCE = `https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?]|${PREVIEW_SOURCE}`;

export type MdToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; value: string }
  | { type: "link"; value: string };

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

/* ------------------------------------------------------------------ markdown (agent answers) */

/** The slice of mdast this file touches. Loose on purpose — we only read `type`/`value`/`children`. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/**
 * The ONLY hrefs an agent's answer may produce: http(s), mailto (what GFM's autolink makes of a
 * bare e-mail) and the panel's own `/preview/<port>/` paths. Everything else — `javascript:`,
 * `data:`, `file:`, a stray relative path — comes back empty, and react-markdown then renders the
 * anchor without an href (see the `a` component, which degrades it to plain text).
 *
 * An allowlist rather than a denylist, because the interesting attacks are always the scheme you
 * did not think to deny. PURE, TOTAL.
 */
export function safeUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (/^https?:\/\/[^\s]/i.test(raw)) return raw;
  if (/^mailto:[^\s]/i.test(raw)) return raw;
  if (new RegExp(`^${PREVIEW_SOURCE}$`).test(raw)) return raw;
  return "";
}

/**
 * Raw HTML in the source becomes LITERAL TEXT.
 *
 * react-markdown does not render raw HTML without `rehype-raw`, but its default is to DROP those
 * nodes — and content disappearing silently is its own kind of lie (an agent explaining a `<div>`
 * would watch it vanish mid-sentence). Turning the node into a text node shows exactly what was
 * written, escaped by React on the way out, which is both honest and inert.
 */
export function remarkEscapeHtml() {
  return (tree: MdNode): void => escapeHtml(tree);
}

function escapeHtml(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as MdNode;
    if (child.type === "html") {
      const value = child.value ?? "";
      // At block level a bare text node has no paragraph to live in; inline it already does.
      children[i] = node.type === "root" ? { type: "paragraph", children: [{ type: "text", value }] } : { type: "text", value };
      continue;
    }
    escapeHtml(child);
  }
}

/**
 * Links the panel's relative `/preview/<port>/…` paths, which GFM's autolink does not (it only
 * knows absolute URLs and e-mails). Walks TEXT nodes only, so a path inside `code` or an existing
 * link is left exactly as it is — no nested anchors, no rewritten snippets.
 */
export function remarkPreviewPaths() {
  return (tree: MdNode): void => linkPreviewPaths(tree);
}

function linkPreviewPaths(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  if (node.type === "link" || node.type === "linkReference") return; // a link inside a link is not a thing
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i] as MdNode;
    if (child.type !== "text") {
      linkPreviewPaths(child);
      continue;
    }
    const split = splitPreviewPaths(child.value ?? "");
    if (!split) continue;
    children.splice(i, 1, ...split);
    i += split.length - 1;
  }
}

/** `null` when there is nothing to link — the caller then leaves the node untouched. PURE. */
function splitPreviewPaths(value: string): MdNode[] | null {
  const pattern = new RegExp(PREVIEW_SOURCE, "g");
  const out: MdNode[] = [];
  let last = 0;
  for (let m = pattern.exec(value); m; m = pattern.exec(value)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({ type: "link", url: m[0], children: [{ type: "text", value: m[0] }] });
    last = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

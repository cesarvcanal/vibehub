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
 *
 * A third shape, `UPLOAD_IMAGE_SOURCE` below, is not a link at all: it becomes the picture itself.
 */
const PREVIEW_SOURCE = "\\/preview\\/\\d{1,5}\\/(?:[^\\s<>()]*[^\\s<>().,;:!?])?";

/**
 * An image the composer uploaded into THIS install's runner.
 *
 * `POST /api/cards/:id/upload` writes it to `/work/.uploads/<cardId>/<stamp>-<name>` and the path
 * is what goes into the message — it is the only form Claude can open, since the uploads live
 * outside the card's worktree. But a path is not a picture: you attached a screenshot, hit Enter,
 * and the bubble came back reading `/work/.uploads/8f3…/1790375978854-image.png`, with no way to
 * see what you had just sent. This shape is the hook that turns those back into the image (see
 * `uploadImageUrl`). Anchored hard — a card id is a uuid and the server sanitises the file name to
 * `[a-z0-9._-]`, so nothing looser than what the upload route itself can produce ever matches.
 */
const UPLOAD_ID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UPLOAD_FILE_SOURCE = "\\d+-[a-z0-9._-]+\\.(?:png|jpe?g|gif|webp|bmp|avif)";
const UPLOAD_IMAGE_SOURCE = `\\/work\\/\\.uploads\\/${UPLOAD_ID_SOURCE}\\/${UPLOAD_FILE_SOURCE}`;

const LINK_SOURCE = `https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?]|${PREVIEW_SOURCE}`;

export type MdToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; value: string }
  | { type: "link"; value: string }
  | { type: "image"; value: string; cardId: string; file: string };

/** `/work/.uploads/<cardId>/<file>` split into its two halves, or `null`. PURE, TOTAL. */
export function parseUploadPath(path: string): { cardId: string; file: string } | null {
  const m = new RegExp(`^${UPLOAD_IMAGE_SOURCE}$`).exec(String(path ?? ""));
  if (!m) return null;
  const parts = m[0].split("/");
  const file = parts.pop() as string;
  const cardId = parts.pop() as string;
  return { cardId, file };
}

/**
 * Where the browser can actually GET that upload: the card-scoped route that reads the file back
 * out of the runner. Same origin, same session cookie, so an `<img src>` simply works. PURE, TOTAL.
 */
export function uploadImageUrl(cardId: string, file: string): string {
  return `/api/cards/${encodeURIComponent(cardId)}/uploads/${encodeURIComponent(file)}`;
}

/**
 * Bare linkification for PLAIN text (a user's own message): text, link and uploaded-image tokens,
 * nothing of markdown is interpreted — a user's asterisks are their asterisks. PURE, TOTAL.
 */
export function linkifyTokens(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  // The image shape comes FIRST in the alternation: an upload path is not a link, and whichever
  // branch matches at the earliest index wins in JS regex alternation only when it is listed first.
  const pattern = new RegExp(`(${UPLOAD_IMAGE_SOURCE}|${LINK_SOURCE})`, "g");
  let last = 0;
  const source = String(text ?? "");
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    if (m.index > last) tokens.push({ type: "text", value: source.slice(last, m.index) });
    const value = m[1] as string;
    const upload = parseUploadPath(value);
    tokens.push(upload ? { type: "image", value, ...upload } : { type: "link", value });
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

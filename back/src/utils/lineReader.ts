import { StringDecoder } from "node:string_decoder";

/**
 * COMPLETE LINES out of a child's stdout, chunk by chunk — the NDJSON reader shared by the transcript
 * follow (services/sdk/mirror.ts), the SDK driver's stdout (manager.ts), the legacy chat route and the
 * credential capture listener.
 *
 * Two things a naive `buffer += chunk.toString()` gets wrong:
 *  - the pipe cuts wherever it likes, the middle of a multibyte character included: decoded chunk
 *    by chunk, that "ç" became two U+FFFD, persisted as-is — and the dedupe by text no longer
 *    matched, so the same sentence came back as a second bubble. The decoder holds an incomplete
 *    character's bytes until the rest of it arrives;
 *  - a line of several MB (a big tool result) arrives in hundreds of chunks: searching the WHOLE
 *    pending text for "\n" on every chunk is quadratic. Only the new piece is searched; the pending
 *    text is split once, when its line finally ends.
 *
 * `maxPending` (optional) drops an unfinished line that grows past it — for a reader that would
 * rather lose a pathological line than hold it in memory (the legacy chat route, see routes/chat.ts).
 */
export function createLineReader(maxPending: number = Number.POSITIVE_INFINITY): (chunk: Buffer) => string[] {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    const text = decoder.write(chunk);
    if (!text.includes("\n")) {
      pending += text;
      if (pending.length > maxPending) pending = "";
      return [];
    }
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maxPending) pending = "";
    return lines;
  };
}

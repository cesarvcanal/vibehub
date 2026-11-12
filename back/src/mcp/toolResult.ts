/**
 * What an MCP tool answers: one text block with the payload as indented JSON. A failure is the same
 * shape with `{ error }` — the agent reads the message and decides, the call itself never throws.
 */
export const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
export const fail = (e: unknown) => ok({ error: (e as Error).message });

import type { FastifyReply } from "fastify";

/**
 * HTTP ERRORS — how a route turns what a service threw into a status. The services speak in
 * messages ("card not found", "... in use by ..."), so the route maps the message: an ordered list
 * of rules, the first that matches wins, and a message no rule claims gets `fallback`. Each route
 * states its own mapping; the default is the common one — "not found" is a 404, the rest is the
 * caller's fault (400).
 */
export type ErrorStatusRule = readonly [pattern: RegExp, status: number];

export const NOT_FOUND: ErrorStatusRule = [/not found/i, 404];

interface ErrorStatusOptions {
  rules?: readonly ErrorStatusRule[];
  fallback?: number;
}

export async function sendError(
  reply: FastifyReply,
  err: unknown,
  { rules = [NOT_FOUND], fallback = 400 }: ErrorStatusOptions = {},
): Promise<FastifyReply> {
  const message = (err as Error).message ?? "invalid request";
  const status = rules.find(([pattern]) => pattern.test(message))?.[1] ?? fallback;
  return await reply.code(status).send({ error: message });
}

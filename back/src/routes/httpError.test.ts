import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { NOT_FOUND, sendError, type ErrorStatusRule } from "./httpError.js";

async function statusOf(message: string, options?: Parameters<typeof sendError>[2]) {
  const app = Fastify();
  app.get("/", async (_req, reply) => await sendError(reply, new Error(message), options));
  const res = await app.inject({ method: "GET", url: "/" });
  await app.close();
  return { status: res.statusCode, body: res.json() as { error: string } };
}

describe("sendError", () => {
  it("defaults to 404 for 'not found' and 400 for the rest, with the message as the body", async () => {
    expect(await statusOf("card not found")).toEqual({ status: 404, body: { error: "card not found" } });
    expect(await statusOf("invalid title")).toEqual({ status: 400, body: { error: "invalid title" } });
  });

  it("checks the rules in order and the first match wins", async () => {
    const rules: ErrorStatusRule[] = [[/in use by/i, 409], NOT_FOUND];
    expect((await statusOf("account not found, in use by card x", { rules })).status).toBe(409);
    expect((await statusOf("account not found", { rules })).status).toBe(404);
  });

  it("a message no rule claims gets the fallback", async () => {
    expect((await statusOf("runner unreachable", { fallback: 502 })).status).toBe(502);
    expect((await statusOf("card not found", { fallback: 502 })).status).toBe(404);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * UM 500 SEM NENHUMA LINHA DE LOG. O servidor sobe com `logger: false`, e o handler de erro padrão
 * do Fastify loga pelo logger DELE — ou seja, em lugar nenhum: a pessoa via "erro interno" e a
 * produção não tinha rastro do que quebrou. Erro de servidor (5xx) vai para o logger do app; erro do
 * cliente (4xx: validação, 404) é resposta normal e não polui o log.
 */

let dir = "";
let app: FastifyInstance;
let error: MockInstance;

// One server for the file: importing the whole app after resetModules takes seconds on Windows.
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-server-errors-"));
  ({ app, error } = await boot());
}, 60_000);
afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => { error.mockClear(); });

async function boot(): Promise<{ app: FastifyInstance; error: MockInstance }> {
  vi.resetModules();
  const env = await import("./config/env.js");
  env.config.dataDir = dir;
  const { logger } = await import("./utils/logger.js");
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  const { buildServer } = await import("./index.js");
  const app = await buildServer();
  app.get("/api/__test/boom", async () => { throw new Error("disk exploded"); });
  app.get("/api/__test/bad", async () => {
    throw Object.assign(new Error("bad input"), { statusCode: 400 });
  });
  await app.ready();
  return { app, error };
}

describe("erros de rota", () => {
  it("um erro inesperado responde 500 e deixa a causa no log, com método e rota", async () => {
    const res = await app.inject({ method: "GET", url: "/api/__test/boom" });
    expect(res.statusCode).toBe(500);
    expect(error).toHaveBeenCalledTimes(1);
    const [fields] = error.mock.calls[0] as [Record<string, unknown>];
    expect((fields.err as Error).message).toBe("disk exploded");
    expect(fields).toMatchObject({ method: "GET", route: "/api/__test/boom" });
  });

  it("um erro do cliente (4xx) não vai para o log de erro", async () => {
    const res = await app.inject({ method: "GET", url: "/api/__test/bad" });
    expect(res.statusCode).toBe(400);
    expect(error).not.toHaveBeenCalled();
  });
});

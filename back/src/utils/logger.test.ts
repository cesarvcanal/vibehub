import { describe, it, expect } from "vitest";
import { logger, onLogLine, type LogLine } from "./logger.js";

describe("onLogLine", () => {
  it("avisa só das linhas a partir do nível pedido e para de avisar depois de desinscrever", () => {
    const heardLines: LogLine[] = [];
    const unsubscribe = onLogLine("error", (line) => heardLines.push(line));
    logger.warn({ card: "a" }, "só um aviso");
    logger.error({ card: "b", action: "x.y" }, "falhou");
    unsubscribe();
    logger.error("depois de desinscrever");
    expect(heardLines).toEqual([
      { level: 50, message: "falhou", fields: { card: "b", action: "x.y" } },
    ]);
  });

  it("entrega o Error passado sozinho como fields.err", () => {
    const heardLines: LogLine[] = [];
    const unsubscribe = onLogLine("error", (line) => heardLines.push(line));
    const failure = new Error("quebrou");
    logger.error(failure);
    unsubscribe();
    expect(heardLines[0]?.fields.err).toBe(failure);
  });
});

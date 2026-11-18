import { describe, it, expect, onTestFinished } from "vitest";
import { logger, notifyListenersAndWrite, onLogLine, type LogLine } from "./logger.js";

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

  it("ouvinte que lança não derruba o logger.error de quem chamou nem os outros ouvintes", () => {
    const heardLines: LogLine[] = [];
    onTestFinished(onLogLine("error", () => { throw new Error("ouvinte quebrado"); }));
    onTestFinished(onLogLine("error", (line) => heardLines.push(line)));
    expect(() => logger.error({ card: "c" }, "falhou mesmo assim")).not.toThrow();
    expect(heardLines.map((line) => line.message)).toEqual(["falhou mesmo assim"]);
  });

  it("a falha de um ouvinte vai para o log pelo método cru, sem passar de novo pelos ouvintes", () => {
    const writtenLines: unknown[][] = [];
    const heardLines: LogLine[] = [];
    onTestFinished(onLogLine("error", () => { throw new Error("ouvinte quebrado"); }));
    onTestFinished(onLogLine("error", (line) => heardLines.push(line)));
    const writeRawLine = (...args: unknown[]) => { writtenLines.push(args); };
    notifyListenersAndWrite.call(logger, [{ card: "c" }, "falhou"] as never, writeRawLine as never, 50);
    expect(writtenLines).toEqual([[{ detail: "ouvinte quebrado" }, "log line listener failed"], [{ card: "c" }, "falhou"]]);
    expect(heardLines.map((line) => line.message)).toEqual(["falhou"]);
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

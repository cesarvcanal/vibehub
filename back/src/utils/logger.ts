import pino, { type Level } from "pino";
import { config } from "../config/env.js";

export interface LogLine {
  level: number;
  message: string;
  fields: Record<string, unknown>;
}

type LogLineListener = (line: LogLine) => void;

const logLineSubscriptions = new Set<{ minLevel: number; listener: LogLineListener }>();

function toLogLine(args: unknown[], level: number): LogLine {
  const [first, second] = args;
  if (first instanceof Error) return { level, message: typeof second === "string" ? second : first.message, fields: { err: first } };
  if (typeof first === "object" && first !== null) {
    return { level, message: typeof second === "string" ? second : "", fields: first as Record<string, unknown> };
  }
  return { level, message: String(first ?? ""), fields: {} };
}

export function notifyListenersAndWrite(this: pino.Logger, args: Parameters<pino.LogFn>, method: pino.LogFn, level: number): void {
  for (const subscription of logLineSubscriptions) {
    if (level < subscription.minLevel) continue;
    try {
      subscription.listener(toLogLine(args, level));
    } catch (err) {
      const failureFields = err instanceof Error ? { detail: err.message, stack: err.stack } : { detail: String(err) };
      method.call(this, failureFields, "log line listener failed");
    }
  }
  method.apply(this, args);
}

export const logger = pino({
  level: config.logLevel,
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true } },
  hooks: { logMethod: notifyListenersAndWrite },
});

export function onLogLine(minLevel: Level, listener: LogLineListener): () => void {
  const subscription = { minLevel: pino.levels.values[minLevel]!, listener };
  logLineSubscriptions.add(subscription);
  return () => {
    logLineSubscriptions.delete(subscription);
  };
}

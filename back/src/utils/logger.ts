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

export const logger = pino({
  level: config.logLevel,
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true } },
  hooks: {
    logMethod(args, method, level) {
      for (const subscription of logLineSubscriptions) {
        if (level >= subscription.minLevel) subscription.listener(toLogLine(args, level));
      }
      method.apply(this, args);
    },
  },
});

export function onLogLine(minLevel: Level, listener: LogLineListener): () => void {
  const subscription = { minLevel: pino.levels.values[minLevel]!, listener };
  logLineSubscriptions.add(subscription);
  return () => {
    logLineSubscriptions.delete(subscription);
  };
}

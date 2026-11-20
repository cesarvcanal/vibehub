import { ANALYSIS_DIMENSIONS, type AnalysisDimension, type Review, type ReviewFleetRun } from "@/api/types";
import { formatAgentResult } from "@/features/board/lib/sdkChat";

export type AgentReading =
  | { kind: "findings"; titles: string[] }
  | { kind: "verdict"; confirmed: boolean; evidence?: string }
  | { kind: "text"; text: string };

const JUDGE_LABEL = "juiz";
export const LABEL_SEPARATOR = " · ";
const JSON_STRING = String.raw`"((?:[^"\\]|\\.)*)`;
const TITLE_PATTERN = new RegExp(String.raw`"title"\s*:\s*${JSON_STRING}"`, "g");
const CONFIRMED_PATTERN = /"confirmed"\s*:\s*(true|false)/;
const EVIDENCE_PATTERN = new RegExp(String.raw`"evidence"\s*:\s*${JSON_STRING}`);
const SUMMARY_PATTERN = new RegExp(String.raw`^\{\s*"summary"\s*:\s*${JSON_STRING}`);

export function fleetsByRound(review: Review, liveFleet: ReviewFleetRun[]): Map<number, ReviewFleetRun[]> {
  const persisted = (review.fleet ?? []).filter((entry) => entry.runs.length > 0).map((entry) => [entry.round, entry.runs] as const);
  const recordedRunIds = new Set(persisted.flatMap(([, runs]) => runs.map((run) => run.runId)));
  const openRoundFleet = liveFleet.filter((run) => !recordedRunIds.has(run.runId));
  const reviewerTurnOpen = review.lastSubmitRound !== review.round && openRoundFleet.length > 0;
  return new Map(reviewerTurnOpen ? [...persisted, [review.round, openRoundFleet] as const] : persisted);
}

function unescapeJsonString(captured: string): string {
  try {
    return JSON.parse(`"${captured}"`) as string;
  } catch {
    return captured;
  }
}

function readParsed(parsed: unknown): AgentReading | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  if (Array.isArray(fields.findings)) {
    const titles = fields.findings
      .map((finding) => (finding && typeof finding === "object" ? (finding as Record<string, unknown>).title : undefined))
      .filter((title): title is string => typeof title === "string");
    return { kind: "findings", titles };
  }
  if (typeof fields.summary === "string" && Object.keys(fields).length === 1) return { kind: "text", text: fields.summary };
  if (typeof fields.confirmed === "boolean") {
    return typeof fields.evidence === "string"
      ? { kind: "verdict", confirmed: fields.confirmed, evidence: fields.evidence }
      : { kind: "verdict", confirmed: fields.confirmed };
  }
  return null;
}

function readTruncated(text: string): AgentReading | null {
  const confirmed = CONFIRMED_PATTERN.exec(text);
  if (confirmed) {
    const evidence = EVIDENCE_PATTERN.exec(text);
    const verdict = confirmed[1] === "true";
    return evidence ? { kind: "verdict", confirmed: verdict, evidence: unescapeJsonString(evidence[1]) } : { kind: "verdict", confirmed: verdict };
  }
  const titles = [...text.matchAll(TITLE_PATTERN)].map((match) => unescapeJsonString(match[1]));
  if (titles.length > 0) return { kind: "findings", titles };
  const summary = SUMMARY_PATTERN.exec(text);
  return summary ? { kind: "text", text: unescapeJsonString(summary[1]) } : null;
}

export function readAgentResult(raw: string): AgentReading {
  const text = raw.trim();
  if (!text.startsWith("{")) return { kind: "text", text };
  try {
    return readParsed(JSON.parse(text)) ?? { kind: "text", text: formatAgentResult(text) };
  } catch {
    return readTruncated(text) ?? { kind: "text", text };
  }
}

export type AgentRole =
  | { kind: "context" }
  | { kind: "review"; dimension: AnalysisDimension }
  | { kind: "verification"; dimension: AnalysisDimension }
  | { kind: "judge" }
  | { kind: "other"; label: string };

const ROLE_PREFIXES = [["revisão:", "review"], ["verificação:", "verification"]] as const;

function asDimension(text: string): AnalysisDimension | undefined {
  return (ANALYSIS_DIMENSIONS as readonly string[]).includes(text) ? (text as AnalysisDimension) : undefined;
}

export function agentRole(label: string): AgentRole {
  if (label === "contexto") return { kind: "context" };
  if (label === JUDGE_LABEL) return { kind: "judge" };
  for (const [prefix, kind] of ROLE_PREFIXES) {
    if (!label.startsWith(prefix)) continue;
    const dimension = asDimension(label.slice(prefix.length).split(LABEL_SEPARATOR)[0]!.trim());
    if (dimension) return { kind, dimension };
  }
  return { kind: "other", label };
}

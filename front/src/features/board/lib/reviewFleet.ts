import { ANALYSIS_DIMENSIONS, type AnalysisDimension, type Review, type ReviewFleetAgent, type ReviewFleetRun } from "@/api/types";
import type { ConversationRow } from "@/features/board/lib/review";
import { formatAgentResult } from "@/features/board/lib/sdkChat";

/** What a fleet agent returned, in the shape the conversation draws it. PURE. */
export type AgentReading =
  | { kind: "findings"; titles: string[] }
  | { kind: "verdict"; confirmed: boolean; evidence?: string }
  | { kind: "text"; text: string };

export interface FleetMessage {
  agent: ReviewFleetAgent;
  reading: AgentReading;
  /** The finding a verification agent answers: the part of its label after " · ". */
  repliesTo?: string;
}

const JUDGE_LABEL = "juiz";
const VERIFICATION_PREFIX = "verificação:";
const LABEL_SEPARATOR = " · ";
const JSON_STRING = String.raw`"((?:[^"\\]|\\.)*)`;
const TITLE_PATTERN = new RegExp(String.raw`"title"\s*:\s*${JSON_STRING}"`, "g");
const CONFIRMED_PATTERN = /"confirmed"\s*:\s*(true|false)/;
const EVIDENCE_PATTERN = new RegExp(String.raw`"evidence"\s*:\s*${JSON_STRING}`);

/**
 * The fleet of each round: the one persisted when the reviewer handed it back, and, for the current
 * round while the reviewer has not handed it back yet, the live one. Rounds without a fleet are left out. PURE.
 */
export function fleetsByRound(review: Review, liveFleet: ReviewFleetRun[]): Map<number, ReviewFleetRun[]> {
  const persisted = (review.fleet ?? []).filter((entry) => entry.runs.length > 0).map((entry) => [entry.round, entry.runs] as const);
  const recordedRunIds = new Set(persisted.flatMap(([, runs]) => runs.map((run) => run.runId)));
  const openRoundFleet = liveFleet.filter((run) => !recordedRunIds.has(run.runId));
  const reviewerTurnOpen = review.lastSubmitRound !== review.round && openRoundFleet.length > 0;
  return new Map(reviewerTurnOpen ? [...persisted, [review.round, openRoundFleet] as const] : persisted);
}

/** A JSON string the regex captured, unescaped; the raw capture when it was cut mid-escape. PURE. */
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

/** What survives of a JSON the probe cut at its size cap. PURE. */
function readTruncated(text: string): AgentReading | null {
  const confirmed = CONFIRMED_PATTERN.exec(text);
  if (confirmed) {
    const evidence = EVIDENCE_PATTERN.exec(text);
    const verdict = confirmed[1] === "true";
    return evidence ? { kind: "verdict", confirmed: verdict, evidence: unescapeJsonString(evidence[1]) } : { kind: "verdict", confirmed: verdict };
  }
  const titles = [...text.matchAll(TITLE_PATTERN)].map((match) => unescapeJsonString(match[1]));
  return titles.length > 0 ? { kind: "findings", titles } : null;
}

/**
 * An agent's result as a short readable line: the findings it raised, the verdict of a verification,
 * or — for any other shape — the chat's own reading of a result. A JSON cut by the probe's cap still
 * yields what survives of it (titles, verdict, evidence); anything else comes back as it came. PURE.
 */
export function readAgentResult(raw: string): AgentReading {
  const text = raw.trim();
  if (!text.startsWith("{")) return { kind: "text", text };
  try {
    return readParsed(JSON.parse(text)) ?? { kind: "text", text: formatAgentResult(text) };
  } catch {
    return readTruncated(text) ?? { kind: "text", text };
  }
}

/**
 * The agents of a run that finished, as a conversation: in the order they finished, the judge last;
 * a verification agent replies to the finding its label names. PURE.
 */
export function fleetMessages(run: ReviewFleetRun): FleetMessage[] {
  const finished = run.agents.filter((agent) => agent.status === "done");
  const byEnd = (left: ReviewFleetAgent, right: ReviewFleetAgent) => (left.endedAt ?? 0) - (right.endedAt ?? 0);
  const judges = finished.filter((agent) => agent.label === JUDGE_LABEL).sort(byEnd);
  const others = finished.filter((agent) => agent.label !== JUDGE_LABEL).sort(byEnd);
  return [...others, ...judges].map((agent) => {
    const separator = agent.label.indexOf(LABEL_SEPARATOR);
    const repliesTo = agent.label.startsWith(VERIFICATION_PREFIX) && separator >= 0 ? agent.label.slice(separator + LABEL_SEPARATOR.length) : undefined;
    const reading = agent.result ? readAgentResult(agent.result) : { kind: "text" as const, text: "" };
    return repliesTo ? { agent, reading, repliesTo } : { agent, reading };
  });
}

export type ConversationRowWithFleet = ConversationRow | { kind: "fleet"; round: number; runs: ReviewFleetRun[]; key: string };

/**
 * The conversation with each round's fleet in place: right before the reviewer's line of that round (the round
 * the fleet produced), or at the end of the round while the reviewer has not answered yet. PURE.
 */
export function withFleets(rows: ConversationRow[], fleets: Map<number, ReviewFleetRun[]>): ConversationRowWithFleet[] {
  const placed = new Set<number>();
  const fleetRow = (round: number): ConversationRowWithFleet[] => {
    const runs = fleets.get(round);
    if (!runs || placed.has(round)) return [];
    placed.add(round);
    return [{ kind: "fleet", round, runs, key: `fleet-${round}` }];
  };
  const roundOf = (row: ConversationRow) => (row.kind === "round" ? row.round : row.event.round);
  const merged = rows.flatMap((row, index): ConversationRowWithFleet[] => {
    const previousRound = index > 0 ? roundOf(rows[index - 1]!) : undefined;
    const closingPrevious = row.kind === "round" && previousRound !== undefined ? fleetRow(previousRound) : [];
    const beforeReviewer = row.kind === "line" && row.event.who === "reviewer" ? fleetRow(row.event.round) : [];
    return [...closingPrevious, ...beforeReviewer, row];
  });
  const lastRound = rows.length > 0 ? roundOf(rows[rows.length - 1]!) : undefined;
  const trailing = [...fleets.keys()].filter((round) => !placed.has(round) && (lastRound === undefined || round >= lastRound));
  return [...merged, ...trailing.flatMap(fleetRow)];
}

/** Who an agent of the fleet is, read from its label ("revisão: correctness", "verificação: tests · <título>", "juiz"). PURE. */
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

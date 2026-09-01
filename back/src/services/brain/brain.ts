import { hostExecutor, shQuote, assertSafeRemotePath } from "../../runtime/host.js";
import { config, dataPath } from "../../config/env.js";
import { JsonStore } from "../../store/jsonStore.js";
import { allProfiles, type McpProfile } from "../mcp/mcp.js";
import { DEFAULT_CLAUDE_DIR } from "../accounts/profiles.js";
import { logger } from "../../utils/logger.js";

/**
 * THE BRAIN — the global instructions every card's terminal starts with. One markdown document,
 * written as CLAUDE.md at the ROOT of every profile in the runner (/root/.claude/CLAUDE.md plus
 * each /root/.claude-profiles/<slug>/CLAUDE.md), so it loads from any cwd in any card.
 *
 * It mirrors the MCP module: injection is idempotent by signature (a `.brain-<signature>` marker),
 * the text travels INSIDE the script over STDIN in a quoted heredoc, and an "Apply now" forces the
 * rewrite. Unlike an MCP payload (single-line JSON) this text is MULTI-LINE — a quoted heredoc
 * (<<'DELIM') expands nothing, and the delimiter is reserved and checked against the text.
 *
 * The brain is NOT a secret (it is instruction text) — but it is still never logged in full; audit
 * records only { action, by, bytes }. A CLAUDE.md can grow to tens of kilobytes and would otherwise
 * bury every other log line.
 */

/**
 * Seed text, used until an operator saves their own. Deliberately about the ENVIRONMENT rather than
 * about any person or company: what the runner is, what is safe to assume, what not to look for.
 * Everything project- or team-specific belongs in the text the operator writes.
 */
export const DEFAULT_BRAIN = `# Working inside a vibehub card

> This is the global \`CLAUDE.md\` for every terminal vibehub opens. It loads from any working
> directory. Edit it under Settings → Brain; saving rewrites it in every runner profile.

## Where you are

- You are running inside a **container** (the vibehub runner), in a **git worktree that vibehub
  already created for this card**, on its own branch. Do not create worktrees and do not go looking
  for the user's laptop, home directory or dotfiles — none of that exists here. Work in the current
  directory.
- The terminal is **disposable**. It can be closed at any moment, so anything worth keeping belongs
  in a commit, a pull request, or a note somewhere durable — never only in the scrollback.
- \`git\` and \`gh\` are already authenticated.

## The card's repository is a starting point, not a fence

A card points at one repository (or none), but that is **organisation, not a boundary**. The
credential in this runner reaches every repository the connected account can reach.

- If the task spans another repository, **clone it alongside** — a subdirectory of your working
  directory, say \`./_repos/<name>\` — branch there, and treat each repository as its own delivery.
- One pull request per repository you touched. The delivery rules above apply in each of them.
- You do not need to ask for a repository to be "added". You already have the access: clone it.

## How to work

1. Read before you write. Explore the repository and match what is already there — its structure,
   its naming, its test style.
2. When something is genuinely ambiguous, ask ONE round of questions with concrete options and a
   recommendation, then carry on. Do not stall on questions you can answer by reading the code.
3. Prefer small, focused commits with messages that explain WHY. Keep unrelated changes apart.
4. Tests are part of the work, not a follow-up: cover the happy path, the edges, and the failure
   you just fixed. Do not claim something works until you have run it.
5. Do not push, open pull requests, or deploy unless you were asked to.

## Reporting

Say what changed and what it means. Skip the preamble, skip restating the request, skip the
narration of your own reasoning. If you could not do something, say so plainly and say why.
`;

/**
 * RESERVED delimiters: a line of the text equal to any of these would break a heredoc wrapping it —
 * the inner one (cat > CLAUDE.md) and the OUTER ones of the scripts that carry `brainInjectLines`
 * (this module's own, and the card-open script that plants the brain on first open). Rejected.
 */
const OUTER_DELIMS = ["VIBEHUB_BRAIN", "VIBEHUB_OPEN"] as const;

/** Delimiter of the heredoc that writes CLAUDE.md — derived from the signature (collision ~nil). PURE. */
function brainHeredoc(signature: string): string {
  return `VIBEHUB_BRAIN_TEXT_${signature}`;
}

/** Short, stable signature of the text (djb2), used to name the idempotency marker. PURE. */
export function brainSignature(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * THROWS when a line of the text collides with a heredoc delimiter (the inner one derived from the
 * signature, or one of the outer ones). Called both at injection time and when saving, so bad text
 * never even reaches the runner. PURE.
 */
export function assertBrainText(text: string): void {
  const reserved = new Set<string>([brainHeredoc(brainSignature(text)), ...OUTER_DELIMS]);
  for (const line of text.split(/\r?\n/)) {
    if (reserved.has(line)) throw new Error(`brain text contains a reserved line ('${line}')`);
  }
}

/**
 * Lines for the BODY of the script that runs inside the runner: they write the brain's CLAUDE.md
 * into each profile. `force=false` is the HOT path (opening a card) and only writes when the
 * `.brain-<signature>` marker is missing, so reopening a card rewrites nothing. `force=true` (the
 * "Apply now" button) always rewrites. The signature changes with the text, so an edited brain is
 * picked up on the next open without anyone pressing the button. PURE.
 */
export function brainInjectLines(profiles: McpProfile[], text: string, force = false): string[] {
  assertBrainText(text);
  const signature = brainSignature(text);
  const delim = brainHeredoc(signature);
  const lines: string[] = [];
  for (const profile of profiles) {
    // The brain is written by ABSOLUTE path (<dir>/CLAUDE.md), so it needs no CLAUDE_CONFIG_DIR —
    // unlike the MCP injection, which shells out to `claude mcp` and needs the prefix to address a
    // profile at all.
    const dir = profile || DEFAULT_CLAUDE_DIR;
    assertSafeRemotePath(dir);
    const marker = `${dir}/.brain-${signature}`;
    const inner: string[] = [
      `mkdir -p ${shQuote(dir)}`,
      `cat > ${shQuote(`${dir}/CLAUDE.md`)} <<'${delim}'`,
      text,
      delim,
      // One marker per current text: drop the old ones, write the new one (that IS the idempotency).
      `rm -f ${shQuote(dir)}/.brain-* 2>/dev/null || true`,
      `: > ${shQuote(marker)}`,
    ];
    if (force) {
      lines.push(...inner);
    } else {
      lines.push(`if [ ! -f ${shQuote(marker)} ]; then`, ...inner, "fi");
    }
  }
  return lines;
}

/** Full host script (host → `docker exec -i … bash -s`) that writes the brain. PURE. */
export function buildBrainInjectScript(
  containerName: string,
  profiles: McpProfile[],
  text: string,
  force = false,
): string {
  return [
    "set -e",
    `docker exec -i ${shQuote(containerName)} bash -s <<'VIBEHUB_BRAIN'`,
    "set -e",
    ...brainInjectLines(profiles, text, force),
    "VIBEHUB_BRAIN",
  ].join("\n");
}

/* ------------------------------------------------------------- project brain */

/**
 * THE PROJECT BRAIN — besides the GLOBAL text above, each project can carry its own instructions.
 * They are delivered as `CLAUDE.local.md` at the ROOT of each card's WORKTREE: Claude Code loads it
 * natively as project memory (alongside the repository's own CLAUDE.md) in BOTH modes — the TUI
 * session and the native chat's SDK driver (`settingSources: ["user","project","local"]`, cwd = the
 * worktree) — so one mechanism serves the two. The file never dirties the repository: the open
 * script excludes it through the clone's `.git/info/exclude` (shared by every worktree of the clone).
 *
 * Like the global brain, the text is read at session START: a save rewrites the file in every
 * existing worktree of the project right away, and the staggered restart makes running cards pick
 * it up (idle cards now, working cards when they go idle).
 */
export const PROJECT_BRAIN_FILE = "CLAUDE.local.md";

/**
 * Lines for the BODY of a runner script that write (or remove) the project brain in ONE worktree.
 * Empty text = `rm -f` — a cleared project brain disappears from the worktrees instead of going
 * stale. The `[ -d ]` guard makes the same lines safe in the apply-everywhere sweep, where a card
 * may exist on the board without its worktree ever having been provisioned. PURE.
 */
export function projectBrainWriteLines(cwd: string, text: string): string[] {
  assertSafeRemotePath(cwd);
  const file = `${cwd}/${PROJECT_BRAIN_FILE}`;
  if (text.trim() === "") return [`rm -f ${shQuote(file)} 2>/dev/null || true`];
  assertBrainText(text);
  const delim = brainHeredoc(brainSignature(text));
  return [
    `if [ -d ${shQuote(cwd)} ]; then`,
    `cat > ${shQuote(file)} <<'${delim}'`,
    text,
    delim,
    `fi`,
  ];
}

/* --------------------------------------------------------------- learnings */

/** Heading of the append-only section `vibehub_brain_learn` is allowed to touch. */
export const LEARNINGS_HEADING = "## Aprendizados";
const LEARNINGS_HEADING_RE = /^##\s+Aprendizados\s*$/i;
/** A learning entry line: `- YYYY-MM-DD: <text>`. */
const LEARNING_LINE_RE = /^-\s*\d{4}-\d{2}-\d{2}:\s*(.*)$/;
const LEARNING_MAX_CHARS = 600;

/**
 * FLATTENS a learning to one plain line: whitespace (INCLUDING newlines) collapses to single
 * spaces. This is the hard protection against poisoning — a "learning" carrying its own headings,
 * heredoc delimiters on a line of their own, or extra bullet sections cannot survive as anything
 * but inline text inside one dated bullet. THROWS on empty and on oversize. PURE.
 */
export function sanitizeLearning(learning: string): string {
  const flat = String(learning ?? "").replace(/\s+/g, " ").trim();
  if (!flat) throw new Error("learning cannot be empty");
  if (flat.length > LEARNING_MAX_CHARS) {
    throw new Error(`learning is too long (${flat.length} > ${LEARNING_MAX_CHARS} chars) — record the essence, not the transcript`);
  }
  return flat;
}

/**
 * APPENDS one dated learning to the `## Aprendizados` section of a brain text and returns the new
 * text. APPEND-ONLY BY CONSTRUCTION: everything outside the section is carried over byte-identical —
 * the only edit this function is capable of is inserting ONE bullet line at the end of the section
 * (creating the section at the end of the document when it does not exist yet). That is the
 * poisoning guard: the tool that calls this cannot rewrite rules, only add entries the operator
 * prunes on the Brain screen. Duplicate text (same sanitized learning already recorded, any date)
 * is a no-op (`added: false`). PURE.
 */
export function appendLearning(
  text: string,
  learning: string,
  date: string = new Date().toISOString().slice(0, 10),
): { text: string; added: boolean; entry: string } {
  const flat = sanitizeLearning(learning);
  const entry = `- ${date}: ${flat}`;
  const lines = text.length ? text.split("\n") : [];
  let start = lines.findIndex((l) => LEARNINGS_HEADING_RE.test(l));
  if (start === -1) {
    // No section yet: it is born at the END of the document — nothing above it moves.
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(LEARNINGS_HEADING);
    start = lines.length - 1;
  }
  // The section runs until the next heading (any level) or the end of the document.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!)) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    const recorded = LEARNING_LINE_RE.exec(lines[i]!)?.[1]?.trim();
    if (recorded === flat) return { text, added: false, entry };
  }
  // Insert at the end of the section, before its trailing blank lines (they separate the next heading).
  let at = end;
  while (at > start + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, entry);
  const out = lines.join("\n");
  assertBrainText(out); // belt — the entry is one prefixed line, it cannot equal a delimiter
  return { text: out, added: true, entry };
}

interface BrainRecord {
  text: string;
  updatedAt: string;
  by: string | null;
}

interface BrainDoc {
  /** null until an operator saves their own text — that is what makes DEFAULT_BRAIN a SEED. */
  brain: BrainRecord | null;
  /** Per-PROJECT brain texts, by project id. No seed: absent = the project has no brain yet. */
  projects: Record<string, BrainRecord>;
}

const store = new JsonStore<BrainDoc>(
  dataPath("brain.json"),
  () => ({ brain: null, projects: {} }),
  (raw) => {
    const doc = raw as BrainDoc;
    const stored = doc?.brain;
    const projects: Record<string, BrainRecord> = {};
    for (const [id, rec] of Object.entries(doc?.projects ?? {})) {
      if (rec && typeof rec.text === "string" && rec.text.trim() !== "") {
        projects[id] = { text: rec.text, updatedAt: rec.updatedAt, by: rec.by ?? null };
      }
    }
    if (!stored || typeof stored.text !== "string") return { brain: null, projects };
    return { brain: { text: stored.text, updatedAt: stored.updatedAt, by: stored.by ?? null }, projects };
  },
);

/** The EFFECTIVE brain text: whatever was saved, otherwise the seed. */
export async function resolveBrainText(): Promise<string> {
  return (await store.load()).brain?.text ?? DEFAULT_BRAIN;
}

export interface BrainView {
  text: string;
  /** The seed, so the UI can offer "reset to default" and show what a fresh install would use. */
  defaultText: string;
  /** Absent while nothing has been saved. */
  updatedAt?: string;
  by?: string;
}

/** What the Brain screen renders. */
export async function brainView(): Promise<BrainView> {
  const rec = (await store.load()).brain;
  if (!rec) return { text: DEFAULT_BRAIN, defaultText: DEFAULT_BRAIN };
  return {
    text: rec.text,
    defaultText: DEFAULT_BRAIN,
    updatedAt: rec.updatedAt,
    ...(rec.by ? { by: rec.by } : {}),
  };
}

/**
 * Saves the brain text. Validated HERE (not only at injection time) so text that would break a
 * heredoc is rejected at the point the operator can still fix it, rather than at apply time.
 */
export async function setBrainText(text: string, by?: string): Promise<BrainRecord> {
  const value = String(text ?? "");
  if (value.trim() === "") throw new Error("brain text cannot be empty");
  assertBrainText(value);
  const rec: BrainRecord = { text: value, updatedAt: new Date().toISOString(), by: by ?? null };
  await store.mutate((doc) => {
    doc.brain = rec;
  });
  logger.info({ audit: true, action: "brain.save", bytes: Buffer.byteLength(value), by }, "brain text saved");
  return rec;
}

/** Drops the saved text, so the seed applies again. */
export async function resetBrain(by?: string): Promise<void> {
  await store.mutate((doc) => {
    doc.brain = null;
  });
  logger.info({ audit: true, action: "brain.reset", by }, "brain reset to the default text");
}

/**
 * WRITES the brain (force=true) into every profile of the runner.
 *
 * The panel this came from looped over one runner per server; vibehub has exactly ONE runner, so
 * the loop is gone — the return keeps `runners` (always 1) so callers read the same field. The text
 * itself is never logged, only its size.
 */
export async function applyBrainEverywhere(by?: string): Promise<{ runners: number; bytes: number }> {
  const text = await resolveBrainText();
  const bytes = Buffer.byteLength(text);
  const profiles = await allProfiles();
  const container = config.runner.container;
  await hostExecutor().runScript(buildBrainInjectScript(container, profiles, text, true), { timeoutMs: 300_000 });
  logger.info(
    { audit: true, action: "brain.apply", runners: 1, profiles: profiles.length, bytes, by },
    "brain applied to the runner",
  );
  return { runners: 1, bytes };
}

/* ---------------------------------------------------- project brain (store) */

/** The project's brain text — empty string when the project has none. */
export async function resolveProjectBrainText(projectId: string): Promise<string> {
  return (await store.load()).projects[projectId]?.text ?? "";
}

export interface ProjectBrainView {
  text: string;
  updatedAt?: string;
  by?: string;
}

/** What the Brain screen renders for one project. Empty text = nothing saved yet (no seed). */
export async function projectBrainView(projectId: string): Promise<ProjectBrainView> {
  const rec = (await store.load()).projects[projectId];
  if (!rec) return { text: "" };
  return { text: rec.text, updatedAt: rec.updatedAt, ...(rec.by ? { by: rec.by } : {}) };
}

/**
 * Saves a project's brain text — validated here like the global one. Unlike the global (which has a
 * seed to fall back to), an EMPTY save CLEARS the project brain: the record is dropped and the
 * apply removes `CLAUDE.local.md` from the project's worktrees.
 */
export async function setProjectBrainText(projectId: string, text: string, by?: string): Promise<ProjectBrainView> {
  const id = String(projectId ?? "").trim();
  if (!id) throw new Error("project id is required");
  const value = String(text ?? "");
  if (value.trim() === "") {
    await store.mutate((doc) => {
      delete doc.projects[id];
    });
    logger.info({ audit: true, action: "brain.project.clear", project: id, by }, "project brain cleared");
    return { text: "" };
  }
  assertBrainText(value);
  const rec: BrainRecord = { text: value, updatedAt: new Date().toISOString(), by: by ?? null };
  await store.mutate((doc) => {
    doc.projects[id] = rec;
  });
  logger.info(
    { audit: true, action: "brain.project.save", project: id, bytes: Buffer.byteLength(value), by },
    "project brain text saved",
  );
  return { text: rec.text, updatedAt: rec.updatedAt, ...(rec.by ? { by: rec.by } : {}) };
}

/**
 * APPENDS one dated learning to the project's `## Aprendizados` section — the ONLY write path the
 * `vibehub_brain_learn` tool has (see appendLearning: append-only by construction; everything
 * outside the section is untouched). Returns whether it was added (false = duplicate) and the
 * project's new text.
 */
export async function appendProjectLearning(
  projectId: string,
  learning: string,
  by?: string,
): Promise<{ added: boolean; entry: string; text: string }> {
  const id = String(projectId ?? "").trim();
  if (!id) throw new Error("project id is required");
  const current = await resolveProjectBrainText(id);
  const result = appendLearning(current, learning);
  if (result.added) {
    const rec: BrainRecord = { text: result.text, updatedAt: new Date().toISOString(), by: by ?? null };
    await store.mutate((doc) => {
      doc.projects[id] = rec;
    });
    logger.info(
      { audit: true, action: "brain.project.learn", project: id, bytes: Buffer.byteLength(result.text), by },
      "learning appended to the project brain",
    );
  }
  return result;
}

export function resetBrainStoreForTesting(): void {
  store.resetForTesting();
}

import { z } from "zod";
import { PR_SECTIONS, MIN_COMMENT_CHARS, type PrDocs } from "../services/maestro/prDocs.js";

/**
 * The PR documentation fields of `vibehub_deliver` — ONE definition for the card's MCP (tools.ts) and
 * the external one (externalTools.ts), so both ask for and pass through exactly the same thing. What
 * the fields must contain is enforced by prDocs.ts; the descriptions here are how the agent learns it.
 */

const SECTIONS = PR_SECTIONS.map((s) => s.label).join(", ");

/** The rule, appended to both tool descriptions. */
export const PR_DOCS_RULE =
  "EVERY PR IS DOCUMENTATION (team rule, any repository): a NEW pull request opens only with `title`, " +
  `\`body\` (markdown with the headings ${SECTIONS}) and \`comments\` on the diff — one per relevant ` +
  "block, saying what changed, why, how it works, its responsibility, impact and rules, for a reviewer " +
  "who never saw this code. Without them the branch is pushed and `reason: 'undocumented'` lists what " +
  "is missing. Write them from the card's own diff (`git diff origin/<branch>...HEAD`); delivering " +
  "ANOTHER card, ask that card to deliver itself. On an existing PR, `title`/`body` rewrite it and " +
  "`comments` are added (ones already there are skipped). 'comments_failed' = GitHub refused a comment " +
  "(a line outside the diff): the PR is open, nothing merged — fix the lines and deliver again.";

export const prDocsInput = {
  title: z.string().optional().describe("PR title: what the change does, in one line. Required to open a new PR."),
  body: z.string().optional().describe(
    `PR description in markdown, with these sections as headings: ${SECTIONS}. Explains the change as a ` +
      "whole (not a list of files), for developers and for someone who does not know the code; tests " +
      "separate what was RUN from what is only recommended. Required to open a new PR.",
  ),
  comments: z.array(z.object({
    path: z.string().describe("file path relative to the repository root, as it appears in the diff"),
    line: z.number().int().describe("line number in the file version of `side`; must be inside the PR's diff (last line of a block)"),
    body: z.string().describe(
      `the explanation of THIS block (at least ${MIN_COMMENT_CHARS} characters): what changed, why, how it works, ` +
        "its responsibility in the flow, the impact on the rest of the system and the rules involved. Never generic.",
    ),
    side: z.enum(["RIGHT", "LEFT"]).optional().describe("RIGHT (default) = the new version; LEFT = a removed line, numbered in the old version"),
    startLine: z.number().int().optional().describe("first line of a multi-line block (same side), before `line`"),
  })).optional().describe(
    "Review comments on the diff, posted as one COMMENT review on the pushed commit. Every relevant block of logic " +
      "(features, business rules, validations, flows, functions, integrations, data handling, errors, persistence, " +
      "auth) gets one; trivial or mechanical lines do not. At least one is required to open a new PR.",
  ),
};

/** The documentation out of a tool call's arguments. */
export function prDocsOf(a: { title?: string; body?: string; comments?: PrDocs["comments"] }): PrDocs {
  return { title: a.title, body: a.body, comments: a.comments };
}

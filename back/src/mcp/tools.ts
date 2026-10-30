import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTerminals, sendToTerminal, readTerminal, reportState, agentOriginFor, SEND_READY_WAIT_MS } from "../services/maestro/maestro.js";
import { DECLARED_STATES, getCard } from "../services/board/registry.js";
import { recordMessage, MESSAGE_TYPES, SEVERITIES, type MessageType, type Severity } from "../services/events/cardEvents.js";
import { sendAnswer } from "./events.js";
import { runGate } from "../services/maestro/gate.js";
import { deliverCard } from "../services/review/deliverCard.js";
import { relayCardActor, actAsParticipant } from "../services/board/actor.js";
import { announcePreview } from "../services/preview/announce.js";
import { recordLearning } from "../services/brain/learn.js";
import { moveCards, AGENT_MOVABLE_COLUMNS, MOVE_BATCH_MAX } from "./cardMove.js";
import { submitReviewerRound, submitAuthorResponse, reviewToolAnswer, HEAD_SHA_RE } from "../services/review/orchestrator.js";
import { MAX_ROUNDS } from "../services/review/model.js";

/**
 * MAESTRO TOOLS — what one card's agent can do to the OTHER cards.
 *
 * These are REAL parallel terminals, not sub-agents: each card has its own Claude process, its own
 * context window, its own worktree and its own branch. A maestro delegates to them and reads their
 * answers, exactly like a person would from the board.
 *
 * The tools reimplement nothing: they call `services/maestro/maestro.ts`, which reuses the same
 * registry and runner code the UI uses.
 */

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ok({ error: (e as Error).message });

/*
 * PR REVIEW — the shapes the two review AIs hand back. The enums are the server's contract, checked
 * here before anything reaches the orchestrator: a severity, proof kind or status outside the list is
 * refused, never coerced (an unknown severity would read as "not blocking" and let a PR go ready).
 * Server-owned fields (status, humanDecision, commit, replies) are not in the finding schema, so zod
 * strips them if an AI sends them anyway.
 */
const reviewRound = z.number().int().min(1).max(MAX_ROUNDS).describe("the review round you were asked for (1-3)");
const reviewHeadSha = z.string().regex(HEAD_SHA_RE, "the full sha of `git rev-parse HEAD`")
  .describe("full sha of `git rev-parse HEAD` after you finished (40 hex chars)");
const reviewFinding = z.object({
  severity: z.enum(["blocking", "suggestion", "question", "refuted"])
    .describe("blocking = only with proof | suggestion | question = a risk you are not sure about (a human decides) | refuted"),
  title: z.string().min(1).max(300),
  file: z.string().max(400).optional(),
  line: z.number().int().positive().optional(),
  proof: z.object({
    kind: z.enum(["failing_test", "rule", "scenario"]),
    // An empty ref is NOT refused here: the model downgrades that blocking to a suggestion (one rule, one place).
    ref: z.string().max(400).describe("the failing test, the written repo rule, or file:line of the scenario"),
    detail: z.string().max(2000).optional(),
  }).optional().describe("required for blocking: without it the server downgrades the finding to a suggestion"),
  fix: z.string().max(2000).optional().describe("the fix you propose"),
  introducedInRound: z.number().int().min(1).max(MAX_ROUNDS).optional()
    .describe("round 2+: the current round, ONLY for a bug the author's own fix created"),
});

export function registerMaestroTools(server: McpServer, actor: string): void {
  server.registerTool(
    "vibehub_list_terminals",
    {
      description:
        "List the terminals on the vibehub board. Each card is a real Claude Code terminal running " +
        "in a container, with its own session and context. Returns id, title, project, board column, " +
        "status (working/waiting), situation (working/waiting/paused/done/no session) and whether the " +
        "session is live. Use it to discover the terminals you can coordinate. `project` (id or part " +
        "of the name) filters — coordinating within the same project is the sane default.",
      inputSchema: {
        project: z.string().optional().describe("project id, or part of its name. Absent = every project."),
      },
    },
    async (a) => {
      try {
        return ok(await listTerminals(a.project));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_send_to_terminal",
    {
      description:
        "Delegate an instruction to another card: `text` arrives as a message in that card's " +
        "conversation (its native chat when that is on, else typed at its terminal's prompt), exactly " +
        "as if a person had sent it. A card that is asleep (hibernated, never opened) is woken on its " +
        "own; a card PAUSED on purpose is refused — ask the user. A PR reviewer card is refused too (the review drives " +
        "it). Fails clearly when no Claude can run there. The receiving card keeps its own context, so " +
        "send a self-contained instruction, not a fragment of your conversation.",
      inputSchema: {
        cardId: z.string().describe("id of the destination card (from vibehub_list_terminals)"),
        text: z.string().describe("the instruction to type at that terminal's prompt (submitted with Enter)"),
        from: z.string().optional().describe(
          "YOUR OWN card id — the $VIBEHUB_CARD_ID of this terminal. Always pass it: it is how the " +
          "destination card's chat shows WHO sent the message (your card's name, linked back to it).",
        ),
        inReplyTo: z.string().optional().describe(
          "the eventId this message ANSWERS (a card.event with needsAnswer): the card is told which " +
          "question it settles, and the event closes",
        ),
      },
    },
    async (a) => {
      try {
        // A PR reviewer card answers only to the review: an author AI "helping" there would tell the
        // reviewer AI what to mark fixed, and the next `gh pr review` would go out as the author (the
        // send makes the sender's person the card's actor). The orchestrator calls the send directly.
        if ((await getCard(a.cardId))?.reviewOf) {
          throw new Error(
            "this is a PR reviewer session; it is driven by the review, not by other cards — " +
              "answer the review with vibehub_review_respond from your own card",
          );
        }
        return ok(await sendAnswer(a.cardId, a.inReplyTo, a.text, async (text) => sendToTerminal(a.cardId, text, {
          by: actor,
          // The order came from the PERSON behind the sending card: the destination works as them —
          // once the send is certain to go (a refused send leaves the authorship alone).
          beforeDeliver: () => relayCardActor(a.from, a.cardId),
          respectHumanActive: true,
          // Never type into a menu (Enter would pick its highlighted option — on the trust dialog,
          // "No, exit"), and give a card that is still booting the time to draw its prompt.
          guardInteractiveMenu: true,
          readyWaitMs: SEND_READY_WAIT_MS,
          wake: true,
          origin: await agentOriginFor(a.from),
        })));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_notify",
    {
      description:
        "Send a MESSAGE about THIS card to whoever follows the board (people and other AI agents " +
        "subscribed to card.event over MCP push; it also lands in their inbox). `type` says what it " +
        "is for: 'info', 'error', 'done' are news; 'question' and 'approval' FORMALLY ask for an answer " +
        "and need `question` (a question also needs 2+ `options`, and `recommended` must be one of " +
        "them). Only these two ask — a '?' inside an info asks nothing. Sending does not pause your " +
        "turn and nothing acts on its own: an answer, if any, arrives as a new message to this card. " +
        "Retrying? Pass the same `idempotencyKey` and it is announced once. `card` is YOUR OWN card id " +
        "($VIBEHUB_CARD_ID).",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        type: z.enum(MESSAGE_TYPES as unknown as [MessageType, ...MessageType[]]).describe("info | question | approval | error | done"),
        text: z.string().min(1).max(2000).describe("what happened, readable on its own"),
        severity: z.enum(SEVERITIES as unknown as [Severity, ...Severity[]]).optional().describe("info | warning | critical"),
        context: z.string().max(2000).optional().describe("what led here — what the reader needs to decide"),
        question: z.string().max(500).optional().describe("question/approval: exactly what is being asked"),
        options: z.array(z.object({ label: z.string().min(1).max(80), description: z.string().max(300).optional() }))
          .max(6).optional().describe("the choices (a question needs 2+)"),
        recommended: z.string().optional().describe("the label of the option you recommend"),
        idempotencyKey: z.string().max(80).optional().describe("same key = same message (safe retries)"),
      },
    },
    async (a) => {
      try {
        const { card, ...message } = a;
        const event = await recordMessage({ cardId: card, ...message });
        return ok({ eventId: event.id, cursor: String(event.seq), needsAnswer: !event.resolvedAt });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_read_terminal",
    {
      description:
        "Read the LAST assistant answers from another card's terminal, as clean text (tool calls and " +
        "JSON noise stripped). Use it after delegating, once that card's situation turns 'waiting' — " +
        "which is how you know its turn finished. Works on a paused card too: what was said stays " +
        "readable. `last` = how many answers to bring back (default 3).",
      inputSchema: {
        cardId: z.string().describe("id of the card to read (from vibehub_list_terminals)"),
        last: z.number().int().min(1).max(20).optional().describe("how many answers to return (default 3)"),
      },
    },
    async (a) => {
      try {
        return ok(await readTerminal(a.cardId, a.last ?? 3));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_report",
    {
      description:
        "Report THIS terminal's own state on the board, so a maestro (or a person) knows where the " +
        "work stands without reading the whole transcript. `state` is your own judgement: 'working' " +
        "(still on it), 'ready' (done, ready to deliver/review), 'needs_me' (stuck on a decision only " +
        "the user can make) or 'blocked' (cannot proceed). `summary` is one short line. This is " +
        "ORTHOGONAL to the board's activity dot — it never moves your card between columns. `card` is " +
        "YOUR OWN card id: the value of the $VIBEHUB_CARD_ID environment variable in this terminal.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        state: z.enum(DECLARED_STATES as unknown as [string, ...string[]]).describe("working | ready | needs_me | blocked"),
        summary: z.string().max(500).optional().describe("one short line describing where the work stands"),
      },
    },
    async (a) => {
      try {
        return ok(await reportState(a.card, a.state, a.summary, actor));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_brain_learn",
    {
      description:
        "Record a DURABLE learning about this card's PROJECT in the project's brain (the " +
        "instructions every card of the project reads). Use it when you discover something lasting " +
        "— an architecture fact, a business rule, a decision, a build gotcha — in 1-3 objective " +
        "sentences. Do NOT record trivia, task status, or secrets/credentials. The entry is APPENDED " +
        "as a dated bullet under the project brain's '## Aprendizados' section — this tool can never " +
        "modify anything else in the brain (append-only; identical text is deduplicated). The user " +
        "curates the section on the Brain screen. `card` is YOUR OWN card id ($VIBEHUB_CARD_ID) — it " +
        "is how the learning is routed to the right project.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        learning: z.string().max(600).describe(
          "the learning, 1-3 objective sentences on ONE line (newlines are collapsed). No secrets.",
        ),
      },
    },
    async (a) => {
      try {
        return ok(await recordLearning(a.card, a.learning, actor));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_preview",
    {
      description:
        "Announce a PREVIEW on your own card: you started a server inside the runner (a dev server, " +
        "an API) and the user should get a clickable link to it. vibehub verifies the port is " +
        "actually LISTENING **and OPENS the page itself** through the same proxy the browser uses, " +
        "records the preview on the card (a visible chip the user clicks) and " +
        "returns the link: answer the user with `path` (/preview/<port>/ — it works on ANY host the " +
        "vibehub panel is opened on; `url` is just that path on the configured public URL, one " +
        "example host). If the port is not listening " +
        "yet, it refuses and tells you what is: start the server first (bound to 127.0.0.1 or " +
        "0.0.0.0) and wait until it listens. It also REFUSES a page that cannot be opened (an app " +
        "that redirects into /preview/<port>/ loops the browser, because the proxy strips that " +
        "prefix) and returns a `warning` when the page opens but is visibly wrong (404 on /, " +
        "absolute assets that will 404) — relay that warning to the user, or fix the app's base. " +
        "ALWAYS pass `command` (and `cwd` when it is not your " +
        "worktree): vibehub stores them so the preview can be RELAUNCHED in its own session after " +
        "your card is paused or restarted — without them the link dies with your terminal. " +
        "`card` is YOUR OWN card id ($VIBEHUB_CARD_ID).",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        port: z.number().int().min(1).max(65535).describe("TCP port the server is listening on inside the runner"),
        label: z.string().max(60).optional().describe("short name for the chip ('front', 'storybook'); default = the port"),
        command: z.string().max(400).optional().describe(
          "single-line start command of the server ('npm run dev -- --port 5173'). Always pass it — it is the relaunch recipe.",
        ),
        cwd: z.string().max(300).optional().describe("absolute directory the command runs in; default = your card's worktree"),
      },
    },
    async (a) => {
      try {
        return ok(await announcePreview(a.card, a.port, { label: a.label, command: a.command, cwd: a.cwd }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_gate",
    {
      description:
        "Run a card's checks in its worktree and report whether they pass — the gate a delivery has " +
        "to clear. It runs `.vibehub/gate.json` (`{ \"checks\": [\"…\"] }`) if the repo has one, else " +
        "sensible defaults (a typecheck and `npm test`) when they are resolvable, else nothing at all. " +
        "Returns { ran, passed, output }: `ran:false` means there was nothing to check (a pass-" +
        "through, not a failure). Output is a redacted tail. Use it only to know if a card is green when " +
        "you are NOT delivering: vibehub_deliver already runs the gate and returns its verdict, so " +
        "running this first just repeats minutes of checks.",
      inputSchema: {
        card: z.string().describe("id of the card to check (from vibehub_list_terminals)"),
      },
    },
    async (a) => {
      try {
        return ok(await runGate(a.card));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_deliver",
    {
      description:
        "Deliver a card: push its branch, open (or reuse) a pull request to `branch`, run the gate, " +
        "and — ONLY when `authorized` is true and the gate is green — merge the PR with a merge commit " +
        "(never a squash). All git/gh runs as the GitHub account of whoever sent the card its latest order (falling back to the project's). Returns { prUrl, " +
        "merged, reason }: `reason` is 'merged' on success, or 'gate' (checks red), 'unauthorized' " +
        "(prepared the PR but was not told to merge), 'locked' (see below), or a git failure. Pass " +
        "`authorized:true` ONLY when the user named where to ship (e.g. 'sobe pra dev'); NEVER by " +
        "default — a merge is a deploy. Cherry-picking to another branch is a separate, explicit " +
        "operation, not part of this. A LOCKED card answers { reason: 'locked', locked: true }: the " +
        "PR goes to that card's own base whatever `branch` said, and it is NEVER merged from here — " +
        "say so plainly ('o PR está aberto em <base>; o merge é de quem revisa') instead of " +
        "retrying, and do not go around it with git or gh by hand. A card whose PR is under REVIEW: " +
        "the push always happens (it is how the author delivers a fix), and the merge goes through only " +
        "when the order came from the review's merger and the review is ready — the same merge as the " +
        "panel's button, which also closes the review. Otherwise 'review_active' says who merges and " +
        "where the review stands; 'head_moved' = the push brought commits the reviewer has not seen and " +
        "the review went back to them. Never merge a reviewed PR any other way (gh pr merge, the GitHub API).",
      inputSchema: {
        card: z.string().describe("id of the card to deliver (from vibehub_list_terminals)"),
        branch: z.string().optional().describe("target branch for the PR / merge. Absent = the project's base branch."),
        authorized: z.boolean().optional().describe("true = merge (deploy). Only when the user named the target. Never default true."),
      },
    },
    async (a) => {
      try {
        return ok(await deliverCard(a.card, { branch: a.branch, authorized: a.authorized === true, by: actor }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_act_as",
    {
      description:
        "Make this card's git and gh act as ANOTHER PERSON who already gave this card an order — " +
        "when the one talking to you asks for it ('commit and push as Albert', 'open the PR in " +
        "Albert's name, I review it'). From the next command on, commits are authored by that person " +
        "and every push, PR, review and merge (vibehub_deliver included) uses their GitHub account. " +
        "The person must be on the card's participant list (they sent it a message before) and still " +
        "have work access; anybody else is refused. Without `user` it changes nothing and returns the " +
        "current actor and the participants. The next message a person sends switches the card to " +
        "them again, so switch right before the step that must carry the other account. Returns " +
        "{ actor, participants } or { error }.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        user: z.string().optional().describe("vibehub username to act as (e.g. 'albert'). Absent = only report."),
      },
    },
    async (a) => {
      try {
        return ok(await actAsParticipant(a.card, a.user));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_move_cards",
    {
      description:
        "Move one or MORE cards to a board column — how a card gets CONCLUDED. Use it when work is " +
        "finished (merged/delivered) and the cards should leave the board's live columns: pass every " +
        "card id at once instead of asking the user to drag them one by one. `column` is 'done' " +
        "(finished — the column is sticky, so no terminal activity takes the card back out) or " +
        "'backlog' (park it as not started). Pausing or resuming a card is NOT here: 'paused', " +
        "'waiting' and 'working' kill or start that card's Claude session, so they stay a deliberate " +
        "act on the board. Each card is processed on its own — an unknown id or a card you may not " +
        "touch fails on its line and the others still move. Returns { column, moved, unchanged, " +
        "failed, results }, one entry per card with { cardId, ok, title, project, was, column, " +
        "changed } or an `error`. Moving a card that is already there is a no-op success, so " +
        "re-running a batch is safe. `from` is YOUR OWN card id ($VIBEHUB_CARD_ID): it scopes the " +
        "move to your own project — cards of other projects are refused.",
      inputSchema: {
        cards: z
          .array(z.string())
          .min(1)
          .max(MOVE_BATCH_MAX)
          .describe("card ids to move (from vibehub_list_terminals) — the whole batch in one call"),
        column: z
          .enum(AGENT_MOVABLE_COLUMNS as unknown as [string, ...string[]])
          .describe("done = finished (sticky) | backlog = back to not started"),
        from: z.string().optional().describe(
          "YOUR OWN card id — the $VIBEHUB_CARD_ID of this terminal. Required when a card calls: it " +
          "is what limits the move to the cards of your own project.",
        ),
      },
    },
    async (a) => {
      try {
        // A CARD must say who it is (that is what scopes the batch to its project); the owner's own
        // browser session on the MCP endpoint is not a card and already sees the whole board.
        return ok(await moveCards(a.cards, a.column, { from: a.from, requireFrom: actor === "card", by: actor }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_review_submit",
    {
      description:
        "PR REVIEW, reviewer side: hand back the round you were asked to review, structured. Only the " +
        "reviewer card of that review may call it (`card` = YOUR OWN $VIBEHUB_CARD_ID); the round prompt " +
        "you received names the review, the round and this card. Round 1: `findings` from /code-review. " +
        "Round 2+: `verdicts` on the closed list (fixed | open | dropped — accepting the author's " +
        "contestation is dropped; accepting a risk is a human decision) and new findings ONLY for a bug the " +
        "fix itself created (`introducedInRound` = the round). A blocking finding needs `proof` " +
        "(failing_test, rule or scenario), or the server downgrades it to a suggestion. Calling twice for " +
        "the same round is harmless. This never merges; the merge is a human button. Returns the review's " +
        "phase and `next`, or { error }.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this (reviewer) terminal"),
        review: z.string().optional().describe("the review id from the prompt"),
        round: reviewRound,
        headSha: reviewHeadSha,
        summary: z.string().min(1).max(1000).describe("one or two sentences: the outcome of this round"),
        findings: z.array(reviewFinding).max(100).describe("new findings (round 2+: only the ones the fix introduced; [] otherwise)"),
        verdicts: z.array(z.object({
          id: z.string().min(1).describe("finding id from the list (f1, f2, ...)"),
          status: z.enum(["fixed", "open", "dropped"]),
          reviewerReply: z.string().max(2000).optional().describe("why it is still open, or why the contestation holds"),
        })).max(100).optional().describe("round 2+: one verdict per item of the closed list"),
      },
    },
    async (a) => {
      try {
        const { card, review, ...payload } = a;
        const after = await submitReviewerRound(card, { ...payload, reviewId: review });
        return ok(reviewToolAnswer(after, "reviewer", a.round));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_review_respond",
    {
      description:
        "PR REVIEW, author side: answer the closed list the reviewer sent, after you fixed and pushed to " +
        "the PR branch. Only the author card of that review may call it (`card` = YOUR OWN " +
        "$VIBEHUB_CARD_ID). One item per blocking finding: `fixed` (with the `commit` and a short `reply`) " +
        "or `contested` (the `reply` carries the proof: a test, a written repo rule, a file:line scenario). " +
        "Suggestions may be answered too — `fixed` (commit), `contested` or `wontfix` (the `reply` says why; " +
        "wontfix is for suggestions only) — in the fixing round AND later, also after the review is ready " +
        "(e.g. you were asked to apply them): that closes them on the panel without opening a round. " +
        "Answers to closed items are ignored. Calling twice is harmless. This never merges; the merge is a human button " +
        "(the merger's). Returns the review's phase, `next` and `answered` (how many items now carry the " +
        "status you sent), or { error }.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this (author) terminal"),
        review: z.string().optional().describe("the review id from the prompt"),
        round: reviewRound,
        headSha: reviewHeadSha,
        items: z.array(z.object({
          id: z.string().min(1).describe("finding id from the list (f1, f2, ...)"),
          status: z.enum(["fixed", "contested", "wontfix"]),
          commit: z.string().max(80).optional().describe("the commit that fixes it"),
          reply: z.string().max(2000).describe("what you did, or the proof behind the contestation"),
        })).max(100),
      },
    },
    async (a) => {
      try {
        const { card, review, ...payload } = a;
        const after = await submitAuthorResponse(card, { ...payload, reviewId: review });
        const answered = a.items.filter((it) => after.findings.find((f) => f.id === it.id)?.status === it.status).length;
        return ok({ ...reviewToolAnswer(after, "author", a.round), answered });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

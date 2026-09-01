import { describe, it, expect } from "vitest";
import {
  parseChatEvents,
  toolSummary,
  clampDetail,
  unwrapSlashCommand,
  systemNote,
  buildFollowCommand,
  buildSendKeyScript,
} from "./chat.js";

/**
 * The chat is only ever as good as this parser: everything the browser renders comes out of these
 * functions, and everything the transcript holds that is NOT the conversation has to die here.
 */

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

const userLine = (text: string, over: Record<string, unknown> = {}) =>
  line({
    type: "user",
    uuid: "u1",
    timestamp: "2026-08-22T18:00:00.000Z",
    isSidechain: false,
    message: { role: "user", content: text },
    ...over,
  });

const assistantLine = (content: unknown[], over: Record<string, unknown> = {}) =>
  line({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-08-22T18:00:05.000Z",
    isSidechain: false,
    message: { role: "assistant", model: "claude-opus-5", content },
    ...over,
  });

describe("parseChatEvents", () => {
  it("reads a plain exchange: what was asked and what was answered", () => {
    const events = parseChatEvents(
      [userLine("roda os testes"), assistantLine([{ type: "text", text: "Feito." }])].join("\n"),
    );
    expect(events).toEqual([
      { id: "u1", kind: "user", at: Date.parse("2026-08-22T18:00:00.000Z"), text: "roda os testes" },
      {
        id: "a1#t",
        kind: "assistant",
        at: Date.parse("2026-08-22T18:00:05.000Z"),
        text: "Feito.",
      },
    ]);
  });

  it("turns a tool call into ONE collapsed line naming what it touched", () => {
    const events = parseChatEvents(
      assistantLine([
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
        { type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "/work/repo/src/app.ts" } },
      ]),
    );
    expect(events.map((e) => [e.kind, e.tool, e.text])).toEqual([
      ["tool", "Bash", "Run tests"],
      ["tool", "Edit", "app.ts"],
    ]);
    // Distinct ids per block: the browser dedupes on them and two calls in one message are two lines.
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("drops everything that is the LOG rather than the conversation", () => {
    const noise = [
      line({ type: "attachment", uuid: "x1", attachment: { type: "hook_success" } }),
      line({ type: "file-history-snapshot", uuid: "x2" }),
      line({ type: "mode", mode: "normal" }),
      line({ type: "system", subtype: "hook", uuid: "x3", isMeta: true }),
      // A tool RESULT: Claude Code writes it as a user message.
      line({
        type: "user",
        uuid: "x4",
        toolUseResult: { stdout: "ok" },
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
      // A subagent's private turn.
      assistantLine([{ type: "text", text: "internal" }], { uuid: "x5", isSidechain: true }),
      // Thinking is never shown.
      assistantLine([{ type: "thinking", thinking: "hmm", signature: "sig" }], { uuid: "x6" }),
      "",
      "{ truncated json from tail",
    ].join("\n");
    expect(parseChatEvents(noise)).toEqual([]);
  });

  it("shows a slash command as the command, not as its xml wrapper", () => {
    const events = parseChatEvents(
      userLine("<command-name>/loop</command-name><command-args>5m /status</command-args>", { uuid: "u2" }),
    );
    expect(events[0]?.text).toBe("/loop 5m /status");
  });

  it("skips the terminal's own command output", () => {
    expect(parseChatEvents(userLine("<local-command-stdout>bytes</local-command-stdout>"))).toEqual([]);
  });

  it("a background-task notification is a muted SYSTEM event, not the user's message", () => {
    // The exact shape the harness injects: a `type:"user"` line that is really the harness talking.
    // It used to render as the user's own bubble; now it is a system note carrying the summary.
    const notif =
      "[SYSTEM NOTIFICATION - NOT USER INPUT]\nAn automated background-task event.\n" +
      "<task-notification><task-id>br824e66c</task-id><status>completed</status>" +
      '<summary>Background command "Vigiar reconexão do webhook" completed (exit code 0)</summary>' +
      "</task-notification>";
    expect(parseChatEvents(userLine(notif))).toEqual([
      {
        id: "u1",
        kind: "system",
        at: Date.parse("2026-08-22T18:00:00.000Z"),
        text: 'Background command "Vigiar reconexão do webhook" completed (exit code 0)',
      },
    ]);
  });

  it("keeps the text of a user message that arrived as blocks (a paste with an image)", () => {
    const events = parseChatEvents(
      userLine("", {
        uuid: "u3",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "..." } },
            { type: "text", text: "olha isso" },
          ],
        },
      }),
    );
    expect(events).toEqual([{ id: "u3", kind: "user", at: Date.parse("2026-08-22T18:00:00.000Z"), text: "olha isso" }]);
  });
});

describe("toolSummary", () => {
  it("names the object, never the arguments", () => {
    expect(toolSummary("Read", { file_path: "/work/repo/src/deep/file.ts" })).toBe("file.ts");
    expect(toolSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO · src");
    expect(toolSummary("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(toolSummary("Task", { description: "review the diff", subagent_type: "x" })).toBe("review the diff");
    expect(toolSummary("TodoWrite", { todos: [] })).toBe("");
  });

  it("prefers a Bash description over the command, because that is what the reader wants", () => {
    expect(toolSummary("Bash", { command: "npm test -- --run", description: "Run the tests" })).toBe("Run the tests");
    expect(toolSummary("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("falls back for a tool it has never heard of (an MCP one) without dumping its input", () => {
    expect(toolSummary("mcp__erp__tarefa_criar", { titulo: "arrumar o PDV", payload: { a: 1 } })).toBe("arrumar o PDV");
    expect(toolSummary("mcp__x__y", { blob: "z".repeat(500) })).toBe("");
  });

  it("collapses whitespace and clamps a long line", () => {
    expect(toolSummary("Bash", { command: "echo   a\n  b" })).toBe("echo a b");
    expect(clampDetail("x".repeat(300))).toHaveLength(160);
  });
});

describe("systemNote", () => {
  it("pulls the summary out of a task-notification", () => {
    expect(systemNote("<task-notification><summary>watcher done</summary></task-notification>")).toBe("watcher done");
  });
  it("recognizes the SYSTEM NOTIFICATION envelope even without a summary", () => {
    expect(systemNote("[SYSTEM NOTIFICATION - NOT USER INPUT]\nsomething happened")).toBe("Background task update");
  });
  it("clamps an overlong summary", () => {
    const long = "x".repeat(300);
    const note = systemNote(`<task-notification><summary>${long}</summary></task-notification>`)!;
    expect(note.length).toBeLessThanOrEqual(160);
    expect(note.endsWith("…")).toBe(true);
  });
  it("leaves a real message alone (null)", () => {
    expect(systemNote("roda os testes por favor")).toBeNull();
    expect(systemNote("olha esse <task> aqui no código")).toBeNull();
  });
});

describe("unwrapSlashCommand", () => {
  it("leaves ordinary text alone", () => {
    expect(unwrapSlashCommand("bom dia")).toBe("bom dia");
  });
  it("handles a command with no arguments", () => {
    expect(unwrapSlashCommand("<command-name>/clear</command-name>")).toBe("/clear");
  });
});

describe("buildFollowCommand", () => {
  it("follows the NEWEST transcript and moves across when a new session starts one", () => {
    const cmd = buildFollowCommand("vibehub-runner", "/root/.claude/projects/-work-x", 400);
    expect(cmd).toContain("docker exec -i 'vibehub-runner'");
    expect(cmd).toContain("ls -1t \"$1\"/*.jsonl");
    expect(cmd).toContain("tail -n 400 -F \"$f\"");
    expect(cmd).toContain("'/root/.claude/projects/-work-x'");
  });

  it("heartbeats to stdout, which is what kills it when the reader goes away", () => {
    expect(buildFollowCommand("c", "/dir")).toContain("while printf");
  });

  it("dies on stdin EOF — the check that stops the loop when the backend end of the exec is gone", () => {
    const cmd = buildFollowCommand("c", "/dir");
    // `docker exec -i` so the loop's stdin IS the connection to the backend...
    expect(cmd).toContain("docker exec -i");
    // ...and the sleep doubles as the liveness probe: timeout (rc>128) keeps looping, EOF exits.
    expect(cmd).toContain("read -t 2 -r hb");
    expect(cmd).toContain("[ $rc -le 128 ]");
    expect(cmd).not.toContain("sleep 2");
    // bash on purpose: dash (the runner's sh) has no `read -t`.
    expect(cmd).toContain("bash -c");
  });

  it("carries the marker the reaper uses to recognise a leaked watcher", () => {
    expect(buildFollowCommand("c", "/dir")).toContain("vibehub-transcript-follow");
  });

  it("takes its tail down with it — a signal trap that does not exit would just keep looping", () => {
    const cmd = buildFollowCommand("c", "/dir");
    expect(cmd).toContain("trap");
    expect(cmd).toContain("exit 0");
  });

  it("refuses a path that is not a derived, absolute one", () => {
    expect(() => buildFollowCommand("c", "/dir/../etc")).toThrow(/\.\./);
    expect(() => buildFollowCommand("c", "relative")).toThrow(/absolute/);
  });
});

describe("buildSendKeyScript", () => {
  it("only ever presses a key from the whitelist", () => {
    expect(buildSendKeyScript("c", "card-1", "escape")).toContain("tmux send-keys -t \"$1\" Escape");
    expect(() => buildSendKeyScript("c", "card-1", "Enter")).toThrow(/unknown key/);
    expect(() => buildSendKeyScript("c", "card-1", "; rm -rf /")).toThrow(/unknown key/);
  });

  it("quotes the session name instead of interpolating it", () => {
    expect(buildSendKeyScript("c", "s'; rm -rf /; '", "interrupt")).toContain(`'s'\\''; rm -rf /; '`);
  });
});

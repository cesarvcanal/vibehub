import { describe, expect, it } from "vitest";
import {
  IMPLICIT_MODEL,
  implicitModelTitle,
  accountInUseName,
  cardRunnerHint,
  mcpSecretNames,
  mcpSecretStatus,
  modelInUse,
} from "@/features/board/api";
import type { BoardAccount, BoardCard, BoardMcp, CardSessionInfo } from "@/features/board/api";

function mcp(overrides: Partial<BoardMcp> & { id: string }): BoardMcp {
  return { name: overrides.id, kind: "stdio", ...overrides };
}

/**
 * The status badge is the only thing standing between "this MCP is configured" and an agent that
 * gets stuck on a 401 twenty minutes into a task. The rule that matters: anything not *known* to
 * have a value counts as missing.
 */
describe("mcpSecretNames", () => {
  it("reads env vars for stdio and headers for http/sse", () => {
    expect(mcpSecretNames(mcp({ id: "a", envKeys: ["TOKEN"] }))).toEqual(["TOKEN"]);
    expect(mcpSecretNames(mcp({ id: "b", kind: "http", headerKeys: ["Authorization"] }))).toEqual([
      "Authorization",
    ]);
  });

  it("declares nothing when the server takes no secrets", () => {
    expect(mcpSecretNames(mcp({ id: "c" }))).toEqual([]);
  });
});

describe("mcpSecretStatus", () => {
  it("is ready when every declared name has a value in the vault", () => {
    const status = mcpSecretStatus(mcp({ id: "m", envKeys: ["A", "B"] }), { A: true, B: true });
    expect(status).toMatchObject({ ready: true, none: false, missing: [] });
    expect(status.names).toEqual(["A", "B"]);
  });

  it("names exactly the ones still empty, in declaration order", () => {
    const status = mcpSecretStatus(mcp({ id: "m", envKeys: ["A", "B", "C"] }), { B: true });
    expect(status.missing).toEqual(["A", "C"]);
    expect(status.ready).toBe(false);
  });

  it("treats a name the server never mentioned as MISSING, not as fine", () => {
    // The safe default for "unknown" is the one that makes you look at it.
    expect(mcpSecretStatus(mcp({ id: "m", envKeys: ["TOKEN"] }), {}).missing).toEqual(["TOKEN"]);
    expect(mcpSecretStatus(mcp({ id: "m", envKeys: ["TOKEN"] }), undefined).missing).toEqual([
      "TOKEN",
    ]);
  });

  it("treats an explicit false the same as an absent name", () => {
    expect(mcpSecretStatus(mcp({ id: "m", envKeys: ["TOKEN"] }), { TOKEN: false }).ready).toBe(false);
  });

  it("has no status at all when nothing is declared — not a green tick", () => {
    // Green would claim "configured" about a server that was never asked for anything.
    const status = mcpSecretStatus(mcp({ id: "m" }), {});
    expect(status.none).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual([]);
  });

  it("covers headers the same way as env vars", () => {
    const http = mcp({ id: "m", kind: "http", headerKeys: ["Authorization", "X-Key"] });
    expect(mcpSecretStatus(http, { Authorization: true }).missing).toEqual(["X-Key"]);
  });
});


/* --------------------------------------------------------------- the pills */

function session(overrides: Partial<CardSessionInfo> = {}): CardSessionInfo {
  return { model: null, modelLabel: null, account: { slug: null, name: "" }, situation: "waiting", ...overrides };
}

/**
 * The pills answer one question: what am I talking to RIGHT NOW. "Default model" and "(inherited)"
 * answered a different one — what somebody typed into this card — which is never what is being
 * asked while a terminal is running.
 */
describe("modelInUse", () => {
  it("prefers the card's own pin: that is what the next session starts on", () => {
    expect(modelInUse({ model: "claude-haiku-4-5" }, session({ model: "claude-opus-5" }))).toEqual({
      id: "claude-haiku-4-5",
      label: "Haiku",
    });
  });

  it("reads the live transcript when the card pins nothing", () => {
    expect(modelInUse({ model: null }, session({ model: "claude-opus-5" }))).toEqual({
      id: "claude-opus-5",
      label: "Opus",
    });
  });

  it("names an unlisted model from the server's label, and falls back to the raw id", () => {
    expect(modelInUse(null, session({ model: "claude-x-9", modelLabel: "Experimental" })).label).toBe(
      "Experimental",
    );
    expect(modelInUse(null, session({ model: "claude-x-9" })).label).toBe("claude-x-9");
  });

  it("assumes Claude Code's own default before the first reply, and flags it as an assumption", () => {
    // Never "Default model": a name plus a title saying it is unconfirmed beats a non-answer.
    expect(modelInUse(null, null)).toEqual({
      id: IMPLICIT_MODEL.id,
      label: IMPLICIT_MODEL.label,
      title: implicitModelTitle(),
    });
    expect(IMPLICIT_MODEL.label).toBe("Fable");
  });

  it("treats an empty pin as no pin at all", () => {
    expect(modelInUse({ model: "   " }, session({ model: "claude-sonnet-5" })).id).toBe("claude-sonnet-5");
  });
});

describe("accountInUseName", () => {
  const accounts: BoardAccount[] = [{ slug: "personal", name: "Personal", createdAt: 1 }];

  it("takes the effective account the server resolved, whatever the card says", () => {
    expect(accountInUseName(null, session({ account: { slug: "work", name: "Work" } }), accounts, "Main")).toBe(
      "Work",
    );
  });

  it("names the pinned account when the session has not answered", () => {
    expect(accountInUseName({ accountSlug: "personal" }, null, accounts, "Main")).toBe("Personal");
    // A slug with no account record left is still better than a blank pill.
    expect(accountInUseName({ accountSlug: "gone" }, null, accounts, "Main")).toBe("gone");
  });

  it("falls back to what the card inherits, with no suffix attached", () => {
    expect(accountInUseName(null, null, accounts, "Main")).toBe("Main");
  });
});

describe("cardRunnerHint", () => {
  it("is the footer line that became a tooltip", () => {
    const card = {
      id: "c1",
      projectId: "p1",
      title: "t",
      column: "working",
      base: "dev",
      worktreeSlug: "fix-the-totals-abcd",
      tmuxSession: "card-abcdef12",
      createdAt: 1,
    } as BoardCard;
    expect(cardRunnerHint(card)).toBe("card/fix-the-totals-abcd · base dev · tmux card-abcdef12");
  });

  it("drops the pieces the runner has not written yet rather than printing blanks", () => {
    expect(cardRunnerHint({ id: "c", projectId: "p", title: "t", column: "backlog", base: "dev", createdAt: 1 } as BoardCard)).toBe(
      "base dev",
    );
    expect(cardRunnerHint(undefined)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { mcpSecretNames, mcpSecretStatus } from "@/features/board/api";
import type { BoardMcp } from "@/features/board/api";

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

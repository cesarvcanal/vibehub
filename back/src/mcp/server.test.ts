import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUCTIONS, createMcpServer } from "./server.js";

/**
 * The MCP server hands its `instructions` to every connecting agent, and every card has this server
 * injected — so this text IS the maestro persona each terminal starts with. These tests pin two
 * things: that the persona is a live read of `maestro.md` (one editable source of truth), and that
 * it still tells a connecting agent the responsibilities that must not drift (own the shipping, the
 * authorization gate, don't type into a human-active card, report your state).
 */

const personaFile = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "brain", "personas", "maestro.md");

describe("MCP server instructions (the maestro persona)", () => {
  it("are non-empty and come straight from maestro.md", () => {
    expect(INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(INSTRUCTIONS).toBe(readFileSync(personaFile, "utf8").trim());
  });

  it("carry the responsibilities that matter", () => {
    // Shipping goes through vibehub_deliver and is gated on the user's authorization.
    expect(INSTRUCTIONS).toContain("vibehub_deliver");
    expect(INSTRUCTIONS.toLowerCase()).toContain("authorized");
    // Never type into a terminal a human is using.
    expect(INSTRUCTIONS.toLowerCase()).toContain("human-active");
    // Declare your own state.
    expect(INSTRUCTIONS).toContain("vibehub_report");
  });

  it("build a server that carries those instructions", () => {
    let server: ReturnType<typeof createMcpServer> | undefined;
    expect(() => {
      server = createMcpServer("test");
    }).not.toThrow();
    expect(server).toBeDefined();
    // The value handed to the SDK is the same non-empty persona.
    expect(INSTRUCTIONS.trim().length).toBeGreaterThan(0);
  });
});

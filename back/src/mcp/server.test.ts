import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_INSTRUCTIONS, INSTRUCTIONS, createMcpServer } from "./server.js";

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

  it("never send the agent to vibehub_gate before a delivery — vibehub_deliver already runs the gate", () => {
    // Each gate run is minutes of typecheck + tests. "Check it yourself before you ask to ship" made
    // the flow gate → deliver(unauthorized) → deliver(authorized): three full runs on the same commit.
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const gateDescription = server._registeredTools?.["vibehub_gate"]?.description ?? "";
    for (const text of [INSTRUCTIONS, gateDescription]) {
      expect(text).not.toMatch(/vibehub_gate[^.]*before you ask/i);
      expect(text).not.toMatch(/green before you ask to ship/i);
      expect(text).toMatch(/vibehub_deliver[^.]*already runs the gate/i);
    }
  });

  it("carry the question doctrine (perguntas claras — feedback do dono da instalação)", () => {
    // "A pergunta ficou horrível de entender": short, self-contained, ONE decision per question.
    expect(INSTRUCTIONS).toContain("ONE decision per question");
    expect(INSTRUCTIONS).toContain("rewrite it before");
    // Blocking decisions are ALWAYS an AskUserQuestion call with 2-4 mutually exclusive options.
    expect(INSTRUCTIONS).toContain("ALWAYS an AskUserQuestion");
    expect(INSTRUCTIONS).toContain("mutually exclusive");
    // "Sempre a primeira opção é o cenário recomendado", labelled with the literal suffix.
    expect(INSTRUCTIONS).toContain("The FIRST option is the recommended one");
    expect(INSTRUCTIONS).toContain("(recomendado)");
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

  it("register vibehub_brain_learn and instruct on recording DURABLE learnings only", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const tools = server._registeredTools ?? {};
    expect(Object.keys(tools)).toContain("vibehub_brain_learn");
    // the tool's own contract: append-only into the Aprendizados section, never the rest
    const description = tools["vibehub_brain_learn"]?.description ?? "";
    expect(description).toContain("Aprendizados");
    expect(description.toLowerCase()).toContain("append");
    // the persona tells agents what belongs there — and what never does
    expect(INSTRUCTIONS).toContain("vibehub_brain_learn");
    expect(INSTRUCTIONS.toLowerCase()).toContain("secret");
  });

  it("register vibehub_move_cards and keep its contract explicit (bulk, done/backlog only, own project)", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const tools = server._registeredTools ?? {};
    expect(Object.keys(tools)).toContain("vibehub_move_cards");
    const description = tools["vibehub_move_cards"]?.description ?? "";
    // It takes a LIST and reports per card — the whole reason it exists (ten merged cards to close).
    expect(description).toContain("MORE cards");
    expect(description).toContain("results");
    // The two columns it may reach, and the one it deliberately does not.
    expect(description).toContain("'done'");
    expect(description).toContain("'backlog'");
    expect(description).toContain("Pausing or resuming a card is NOT here");
    // Authorization: the agent acts from its own card, inside its own project.
    expect(description).toContain("$VIBEHUB_CARD_ID");
    expect(description).toContain("your own project");
  });

  it("register the Cofre tools and instruct on using them for logins", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const names = Object.keys(server._registeredTools ?? {});
    expect(names).toContain("vibehub_credential_list");
    expect(names).toContain("vibehub_credential_fill");
    // The persona tells the agent to use the Cofre and never to ask for a password in the chat.
    expect(INSTRUCTIONS).toContain("vibehub_credential_fill");
    expect(INSTRUCTIONS.toLowerCase()).toContain("cofre");
  });
});

describe("MCP server instructions for an external app (ChatGPT, Claude.ai)", () => {
  const externalFile = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "brain", "personas", "external.md");

  it("come straight from external.md", () => {
    expect(EXTERNAL_INSTRUCTIONS).toBe(readFileSync(externalFile, "utf8").trim());
  });

  it("keep the merge behind the user's explicit word and name only the tools the app has", () => {
    expect(EXTERNAL_INSTRUCTIONS).toContain("authorized: true");
    expect(EXTERNAL_INSTRUCTIONS).toContain("vibehub_create_card");
    expect(EXTERNAL_INSTRUCTIONS).not.toContain("vibehub_report");
  });

  it("teach the voice loop: send → wait → relay the question → report what changed", () => {
    // By voice nobody looks at the board: the assistant must wait instead of polling, relay a card's
    // question with its options instead of deciding, and say what was done before delivering.
    expect(EXTERNAL_INSTRUCTIONS).toContain("vibehub_wait_for_card");
    expect(EXTERNAL_INSTRUCTIONS).toContain("sentAt");
    expect(EXTERNAL_INSTRUCTIONS).toContain("pendingQuestion");
    expect(EXTERNAL_INSTRUCTIONS).toContain("vibehub_card_activity");
    expect(EXTERNAL_INSTRUCTIONS).toContain("vibehub_card_changes");
    expect(EXTERNAL_INSTRUCTIONS.toLowerCase()).toContain("voice");
  });
});

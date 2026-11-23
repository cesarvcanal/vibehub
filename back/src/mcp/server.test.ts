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

// external: Claude Code 2.1.330 corta em 4096 caracteres as instructions de um servidor MCP e a descrição de cada ferramenta (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, sufixo "… [truncated]"), lido no binário em 23/11/2026
const MCP_DESCRIPTION_DELIVERED_CHARS = 4096;

const personaFile = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "brain", "personas", "maestro.md");

const cardTools = (createMcpServer("test") as unknown as {
  _registeredTools?: Record<string, { description?: string }>;
})._registeredTools ?? {};
const cardToolDescriptions = Object.entries(cardTools).map(([name, tool]) => [name, tool.description ?? ""] as const);
const cardToolDescription = (name: string): string => cardTools[name]?.description ?? "";

describe("o que o Claude Code entrega ao card sem cortar", () => {
  it("a persona do maestro cabe inteira no limite das instructions", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(MCP_DESCRIPTION_DELIVERED_CHARS);
  });

  it.each(cardToolDescriptions)("a descrição da %s cabe inteira no limite de cada ferramenta", (_name, description) => {
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(MCP_DESCRIPTION_DELIVERED_CHARS);
  });
});

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

  it("ensina o agente a relatar falha do próprio vibehub, e quando não relatar", () => {
    expect(INSTRUCTIONS).toContain("vibehub_report_platform_failure");
    expect(cardToolDescription("vibehub_report_platform_failure")).toMatch(/ended cleanly[^.]*errors of the project's own code/);
  });

  it("manda investigar a fonte, relatar inconsistência e queixa do usuário e contar a resposta sem prometer correção", () => {
    const description = cardToolDescription("vibehub_report_platform_failure");
    expect(description).toMatch(/does not match its source/);
    expect(description).toMatch(/USER describing[^.]*user_report/);
    expect(description).toMatch(/Investigate first/);
    expect(description).toMatch(/`dismissed`[^.]*already judged/);
    expect(description).toContain("Tell the user, in one line, what this answered");
    expect(description).toContain("never promise a fix");
  });

  it("um push que a conta da pessoa não alcança é da tarefa, não o 403 esperado de todo push", () => {
    const description = cardToolDescription("vibehub_report_platform_failure");
    expect(description).not.toContain("the expected 403 of a plain git push");
    expect(description).toContain("a push the person's GitHub account cannot make");
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

  it("toda entrega de PR é documentação: o vibehub_deliver pede título, corpo e comentários", () => {
    // Guideline of 2026-11-09: "isso precisa ser em qualquer PR de qualquer repositório, pois a tool de
    // abrir PR não tá boa a explicação e contexto nela" — the deliver opened with --fill (the list of commits).
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string; inputSchema?: { shape?: Record<string, unknown> } }>;
    };
    const deliver = server._registeredTools?.["vibehub_deliver"];
    expect(Object.keys(deliver?.inputSchema?.shape ?? {})).toEqual(expect.arrayContaining(["title", "body", "comments"]));
    expect(deliver?.description).toContain("EVERY PR IS DOCUMENTATION");
  });

  it("a persona leva o padrão a PR aberto à mão, em qualquer repositório", () => {
    expect(INSTRUCTIONS).toContain("Every pull request is documentation");
    expect(INSTRUCTIONS).toContain("--body-file");
    expect(INSTRUCTIONS).toMatch(/pulls\/<n>\/reviews/);
    expect(INSTRUCTIONS).toContain("never `--fill`");
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

  it("a vibehub_deliver do card diz como perguntar o merge que não foi autorizado: AskUserQuestion com opções", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const deliverDescription = server._registeredTools?.["vibehub_deliver"]?.description ?? "";
    expect(deliverDescription).toMatch(/'unauthorized'[^)]*AskUserQuestion/);
    expect(deliverDescription).toContain("'Mergear em <branch> (recomendado)' and 'Não mergear agora'");
    expect(deliverDescription).toContain("without recommending the merge");
  });

  it("planejar começa no brainstorming; dúvida ou contradição viram pergunta — nunca decisão por conta própria", () => {
    // Request from the install owner (2026-11-03): "sempre use brainstorming quando estivermos
    // planejando… se não ficar claro, NUNCA tomar decisões por conta própria… se entrar em
    // contradição, ir perguntando".
    expect(INSTRUCTIONS).toContain("Planning ALWAYS starts with brainstorming");
    expect(INSTRUCTIONS).toContain("superpowers:brainstorming");
    expect(INSTRUCTIONS).toContain("You NEVER decide on your own");
    expect(INSTRUCTIONS).toContain("keep asking until it is clear");
    expect(INSTRUCTIONS).toContain("Contradiction = ask");
    // The old "pergunte só quando bloquear" let the AI pick on its own how to read the request.
    expect(INSTRUCTIONS).not.toContain("Ask when it blocks, not before");
  });

  it("autonomia corretiva: bug no que já foi pedido se corrige sem pergunta; melhoria fora do escopo vira sugestão", () => {
    // Request from the install owner (2026-11-10): brainstorming and confirmation apply to a change of
    // direction, not to fixing what clearly breaks what they already asked for.
    expect(INSTRUCTIONS).toContain("Corrective autonomy");
    expect(INSTRUCTIONS).toContain("fix it without asking and without brainstorming");
    expect(INSTRUCTIONS).toContain("an improvement is a suggestion, not an authorization");
  });

  it("a autorização dada para a sequência não passa por cima de um item bloqueante aberto no PR", () => {
    expect(INSTRUCTIONS).toContain("An open blocking item declared in the PR still needs the user's own OK for that item");
  });

  it("a pergunta se entende sozinha: diz o que foi achado, por que importa e nomeia o item", () => {
    expect(INSTRUCTIONS).toContain("what was found, why it matters, and the item it is about");
    expect(INSTRUCTIONS).not.toContain("At most one sentence of context");
  });

  it("o executor não reescreve histórico já enviado sem o OK do usuário", () => {
    expect(INSTRUCTIONS).toContain("rewriting commits already pushed needs the user's OK");
  });

  it("o maestro manda cada card se entregar, como pede a vibehub_deliver, porque o PR documenta o diff daquele card", () => {
    expect(INSTRUCTIONS).not.toMatch(/is the one that delivers/);
    expect(INSTRUCTIONS).toContain("delivers itself");
    expect(cardToolDescription("vibehub_deliver")).toContain("ask that card to deliver itself");
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

  it("a descrição da vibehub_analysis_report lista os três status que o done grava, inclusive a dúvida decidida", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const description = server._registeredTools?.["vibehub_analysis_report"]?.description ?? "";
    expect(description).toContain("fixed + commit, decided + decision (a question the person answered without asking for a change), or open");
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
    expect(description.toLowerCase()).toContain("secret");
    expect(INSTRUCTIONS).toContain("vibehub_brain_learn");
  });

  it("ensina o agente a criar card em qualquer projeto pelo vibehub_create_card, em vez de deixar o prompt num arquivo", () => {
    expect(INSTRUCTIONS).toContain("vibehub_create_card");
    expect(INSTRUCTIONS).toContain("vibehub_list_projects");
    expect(cardToolDescription("vibehub_list_projects")).toContain("`canCreateCard`");
    expect(cardToolDescription("vibehub_list_projects")).toContain("when it is false, tell the user the reason instead of trying");
    expect(cardToolDescription("vibehub_create_card")).toContain("never leave the prompt in a file for someone to paste");
    expect(INSTRUCTIONS).not.toMatch(/for now you coordinate the cards that\s+already exist/);
  });

  it("register vibehub_act_as and tell the agent to use it instead of waiting for the other person", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const description = (server._registeredTools ?? {})["vibehub_act_as"]?.description ?? "";
    // The consent limit is part of the contract the agent reads.
    expect(description).toContain("already gave this card an order");
    expect(description).toContain("refused");
    expect(description).toMatch(/Never stop to ask the other person/);
    expect(INSTRUCTIONS).toContain("vibehub_act_as");
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

  it("register the two PR-review tools, and neither one merges", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const tools = server._registeredTools ?? {};
    for (const name of ["vibehub_review_submit", "vibehub_review_respond"]) {
      const description = tools[name]?.description ?? "";
      expect(description).toContain("never merges; the merge is a human button");
      // Who may call it is part of the contract: the card says who it is.
      expect(description).toContain("$VIBEHUB_CARD_ID");
    }
  });

  it("register vibehub_attach_prs, and the instructions send a review request to it instead of a review by hand", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const description = server._registeredTools?.["vibehub_attach_prs"]?.description ?? "";
    expect(description).toContain("$VIBEHUB_CARD_ID");
    expect(description).toContain("Do NOT review them yourself");
    expect(INSTRUCTIONS).toContain("vibehub_attach_prs");
  });

  it("register vibehub_review_start: the card starts the review with the roles said in the chat", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const description = server._registeredTools?.["vibehub_review_start"]?.description ?? "";
    expect(description).toContain("$VIBEHUB_CARD_ID");
    expect(description).toContain("MERGES BY ITSELF in the merger's name");
    expect(INSTRUCTIONS).toContain("vibehub_review_start");
  });

  it("vibehub_review_start carries the merger's 'merge and conclude when it ends' order instead of dropping it", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string; inputSchema?: { shape?: Record<string, unknown> } }>;
    };
    const tool = server._registeredTools?.["vibehub_review_start"];
    expect(Object.keys(tool?.inputSchema?.shape ?? {})).toEqual(expect.arrayContaining(["mergeWhenReady", "concludeWhenMerged"]));
    expect(tool?.description ?? "").toContain("mergeWhenReady");
    expect(tool?.description ?? "").toContain("terminando pode mergear");
  });

  it("vibehub_review_submit says each finding needs the problem and how to fix it, not only a title", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
    };
    const description = server._registeredTools?.["vibehub_review_submit"]?.description ?? "";
    expect(description).toContain("`problem`");
    expect(description).toContain("`fix`");
  });

  it("a vibehub_review_submit manda a rodada 1 vir da frota do Workflow, como o prompt do revisor, e o /code-review só quando ela falha", () => {
    const description = cardToolDescription("vibehub_review_submit");
    expect(description).not.toContain("findings` from /code-review");
    expect(description).toContain("the Workflow fleet the round prompt runs (/code-review only when it fails)");
  });

  it("a vibehub_deliver deixa o detalhe da revisão com a vibehub_review_start e cabe com folga no limite", () => {
    const description = cardToolDescription("vibehub_deliver");
    expect(description).toContain("vibehub_review_start");
    expect(description.length).toBeLessThanOrEqual(3200);
  });

  it("a vibehub_wait_for_card diz para combinar a espera com o usuário e encerrar o turno", () => {
    expect(cardToolDescription("vibehub_wait_for_card")).toContain("Agree on it with the user, say so, and end your turn");
  });

  it("a vibehub_send_to_terminal só recusa o card em que OUTRA pessoa digita, e deixa a ferramenta decidir", () => {
    const description = cardToolDescription("vibehub_send_to_terminal");
    expect(description).toContain("human-active");
    expect(description).toContain("pass `from` and let this tool decide");
  });

  it("a vibehub_preview entrega só o link que ela devolveu e separa o link do usuário do teste no navegador do card", () => {
    const description = cardToolDescription("vibehub_preview");
    expect(description).toContain("Hand out only the link this tool returned");
    expect(description).toContain("navegador");
  });

  it("register the Cofre tools and instruct on using them for logins", () => {
    const server = createMcpServer("test") as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const names = Object.keys(server._registeredTools ?? {});
    expect(names).toContain("vibehub_credential_list");
    expect(names).toContain("vibehub_credential_fill");
    expect(INSTRUCTIONS).toContain("vibehub_credential_fill");
    expect(INSTRUCTIONS.toLowerCase()).toContain("cofre");
    expect(cardToolDescription("vibehub_credential_list")).toContain("NEVER ask for a password in the chat");
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

  it("pedido confuso ou contraditório: pergunta ao usuário antes de mandar ao card", () => {
    expect(EXTERNAL_INSTRUCTIONS).toContain("unclear or contradicts itself");
    expect(EXTERNAL_INSTRUCTIONS).toContain("never fill the gap with your own reading");
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

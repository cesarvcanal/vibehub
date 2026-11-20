import { z } from "zod";
import type { PublicUser } from "../../auth/users.js";
import { recordMessage } from "../events/cardEvents.js";
import { AGENT_MOVABLE_COLUMNS, MOVE_BATCH_MAX } from "../../mcp/cardMove.js";
import type { BoardColumn } from "../board/registry.js";
import {
  UserActionError, listProjectsFor, listCardsFor, createCardFor, sendToCardAs, moveCardsAs,
} from "../maestro/asUser.js";

// external: gpt-6-luna accepted as `delegation.responses.model` by gpt-live-1 (exercised 2026-11-20, developers.openai.com/api/docs/guides/live-delegation)
export const EXECUTOR_MODEL = "gpt-6-luna";

export const VOICE_TOOL_NAMES = ["list_projects", "list_cards", "create_card", "send_to_card", "move_cards", "notify", "ask_card_agent"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface FunctionTool {
  type: "function";
  name: VoiceToolName;
  description: string;
  parameters: JsonSchemaObject;
  strict: true;
}

const NOTIFY_TYPES = ["info", "error", "done"] as const;

const ARGS = {
  list_projects: z.object({}).strict(),
  list_cards: z.object({ project: z.string().nullable() }).strict(),
  create_card: z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200) }).strict(),
  send_to_card: z.object({ cardId: z.string().min(1), text: z.string().trim().min(1).max(20_000) }).strict(),
  move_cards: z.object({
    cards: z.array(z.string().min(1)).min(1).max(MOVE_BATCH_MAX),
    column: z.enum(AGENT_MOVABLE_COLUMNS as unknown as [BoardColumn, ...BoardColumn[]]),
  }).strict(),
  notify: z.object({ type: z.enum(NOTIFY_TYPES), text: z.string().trim().min(1).max(2000) }).strict(),
  ask_card_agent: z.object({ request: z.string().trim().min(1).max(20_000) }).strict(),
} satisfies Record<VoiceToolName, z.ZodTypeAny>;

function objectSchema(properties: Record<string, unknown>): JsonSchemaObject {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const VOICE_TOOLS: Record<VoiceToolName, { description: string; parameters: JsonSchemaObject }> = {
  list_projects: {
    description: "Lista os projetos do vibehub que a pessoa da chamada alcança (id e nome). Use para achar o projectId.",
    parameters: objectSchema({}),
  },
  list_cards: {
    description: "Lista os cards (terminais Claude Code) que a pessoa alcança: id, título, projeto, coluna e situação. Use para achar o cardId.",
    parameters: objectSchema({ project: { type: ["string", "null"], description: "id ou parte do nome do projeto; null = todos" } }),
  },
  create_card: {
    description: "Cria um card novo num projeto, em nome da pessoa da chamada. Só o dono da instalação cria cards.",
    parameters: objectSchema({
      projectId: { type: "string", description: "id do projeto (de list_projects)" },
      title: { type: "string", description: "título curto da tarefa, como deve aparecer no board" },
    }),
  },
  send_to_card: {
    description: "Manda uma instrução a OUTRO card, como mensagem da pessoa da chamada. O agente daquele card não ouve esta " +
      "conversa: mande uma instrução completa (o que fazer, onde, como saber que terminou). Não serve para o card desta chamada.",
    parameters: objectSchema({
      cardId: { type: "string", description: "id do card de destino (de list_cards)" },
      text: { type: "string", description: "a instrução, completa" },
    }),
  },
  move_cards: {
    description: "Move cards para concluído (done) ou para o backlog. Não serve para o card desta chamada.",
    parameters: objectSchema({
      cards: { type: "array", items: { type: "string" }, description: "ids dos cards (de list_cards)" },
      column: { type: "string", enum: [...AGENT_MOVABLE_COLUMNS] },
    }),
  },
  notify: {
    description: "Registra um aviso no card desta chamada (fica no histórico de eventos do board, sem acordar o agente).",
    parameters: objectSchema({
      type: { type: "string", enum: [...NOTIFY_TYPES], description: "info = aviso, error = problema, done = algo concluído" },
      text: { type: "string", description: "o aviso, legível sozinho" },
    }),
  },
  ask_card_agent: {
    description: "Passa ao agente do card desta chamada (Claude Code) uma pergunta ou um pedido que depende do código, do " +
      "histórico do chat, de testes ou de trabalho no projeto. Escreva o pedido completo: o que fazer, onde e o que já foi decidido.",
    parameters: objectSchema({ request: { type: "string", description: "o pedido ao agente, completo" } }),
  },
};

export function voiceToolDefinitions(): FunctionTool[] {
  return VOICE_TOOL_NAMES.map((name) => ({
    type: "function", name, description: VOICE_TOOLS[name].description, parameters: VOICE_TOOLS[name].parameters, strict: true,
  }));
}

export function executorInstructions(call: { cardTitle: string; projectName: string }): string {
  return [
    `Você executa as ordens da pessoa numa chamada de voz do vibehub. A chamada está no card "${call.cardTitle}", ` +
      `do projeto "${call.projectName}". Responda em português do Brasil, curto: a voz fala a sua resposta.`,
    "Ordem no board (criar card, mandar instrução a outro card, mover cards, registrar aviso) você executa direto, com as " +
      "ferramentas, em nome da pessoa. Pergunta ou pedido sobre o código, o histórico do chat, testes ou trabalho no " +
      "projeto deste card vai ao agente do card com ask_card_agent.",
    "Ids saem de list_projects e list_cards; nunca invente um id. Quando a ordem for ambígua (qual projeto? qual card?), " +
      "responda com uma pergunta curta e não chame ferramenta. Só diga que algo foi feito depois que a ferramenta voltou " +
      "sem erro; se voltou erro, diga o erro em poucas palavras.",
  ].join("\n\n");
}

function isVoiceToolName(name: string): name is VoiceToolName {
  return (VOICE_TOOL_NAMES as readonly string[]).includes(name);
}

const BROWSER_TOOL = "ask_card_agent is answered by the call's browser, not by this route";
const NOT_THE_CALL_CARD = "this is the card of the call itself: use ask_card_agent to ask its agent";

function parseJsonArguments(name: string, argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new UserActionError(400, `the arguments of ${name} are not valid JSON`);
  }
}

function parseArgs<T extends z.ZodTypeAny>(name: VoiceToolName, schema: T, json: unknown): z.infer<T> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ");
  throw new UserActionError(400, `invalid arguments for ${name}: ${issues}`);
}

export interface VoiceActionInput {
  user: PublicUser;
  callCard: { id: string };
  name: string;
  argumentsJson: string;
}

export async function runVoiceAction(input: VoiceActionInput): Promise<unknown> {
  const { name } = input;
  if (!isVoiceToolName(name)) throw new UserActionError(400, `unknown voice tool: ${name}`);
  if (name === "ask_card_agent") throw new UserActionError(400, BROWSER_TOOL);
  const json = parseJsonArguments(name, input.argumentsJson);
  switch (name) {
    case "list_projects":
      parseArgs(name, ARGS.list_projects, json);
      return await listProjectsFor(input.user);
    case "list_cards":
      return await listCardsFor(input.user, parseArgs(name, ARGS.list_cards, json).project ?? undefined);
    case "create_card":
      return await createCardFor(input.user, { ...parseArgs(name, ARGS.create_card, json), open: false });
    case "send_to_card": {
      const args = parseArgs(name, ARGS.send_to_card, json);
      if (args.cardId === input.callCard.id) throw new UserActionError(400, NOT_THE_CALL_CARD);
      return await sendToCardAs(input.user, args);
    }
    case "move_cards": {
      const args = parseArgs(name, ARGS.move_cards, json);
      if (args.cards.includes(input.callCard.id)) throw new UserActionError(400, NOT_THE_CALL_CARD);
      return await moveCardsAs(input.user, args.cards, args.column);
    }
    case "notify": {
      const event = await recordMessage({ cardId: input.callCard.id, ...parseArgs(name, ARGS.notify, json) });
      return { eventId: event.id };
    }
  }
}

export const VOICE_ACTION_TTL_MS = 10 * 60_000;

const settledActions = new Map<string, { output: Promise<unknown>; at: number }>();

export function runVoiceActionOnce(key: string, run: () => Promise<unknown>, now: number = Date.now()): Promise<unknown> {
  for (const [storedKey, stored] of settledActions) {
    if (now - stored.at >= VOICE_ACTION_TTL_MS) settledActions.delete(storedKey);
  }
  const known = settledActions.get(key);
  if (known) return known.output;
  const output = run();
  settledActions.set(key, { output, at: now });
  output.catch(() => settledActions.delete(key));
  return output;
}

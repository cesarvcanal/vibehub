import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * O DRIVER DE VERDADE, RODANDO. `driver.test.ts` recorta funções puras do .mjs; o que mora no laço
 * do stream e no teardown (`runStream`, `endStream`, `rewindAndSend`) só existe com estado vivo e
 * tempo passando. Aqui o .mjs roda como no runner — um processo node falando NDJSON por stdin/stdout
 * — contra um SDK FALSO plantado no `node_modules` ao lado dele (o mesmo lugar onde o runner tem o
 * de verdade). O SDK falso faz o que o CLI faz de pior: um stream que não solta, uma interrupção que
 * espera um hook, uma interrupção que nunca responde.
 */

/**
 * The fake `@anthropic-ai/claude-agent-sdk`. Each user message's TEXT picks the CLI behaviour.
 *
 * It never decides by the clock what the test has to observe: it says where it is with a `fake:` line
 * on stderr (the driver's stdout is the protocol), and the turn that must stay running waits on a
 * GATE the test opens — a file in the sandbox. Fixed sleeps here made the tests a bet on the CI's load.
 */
const FAKE_SDK = String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
let created = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (name) => process.stderr.write("fake:" + name + "\n");
const SESSION = "11111111-2222-3333-4444-555555555555";
const CLEARED = "99999999-2222-3333-4444-555555555555";

export function query({ prompt, options }) {
  const index = ++created;
  mark("effort:" + (options.effort ?? "none"));
  let onInterrupt = () => {};
  let interruptAnswer = Promise.resolve();
  const interrupted = () => new Promise((resolve) => { onInterrupt = resolve; });
  async function* run() {
    for await (const m of prompt) {
      const text = m.message.content;
      yield { type: "system", subtype: "init", session_id: SESSION };
      if (text === "stubborn") {
        // Ignores the interrupt AND the closed channel; speaks again only after a NEWER stream exists.
        mark("stubborn:running");
        while (created === index) await sleep(20);
        yield { type: "assistant", uuid: "a-stale", message: { content: [{ type: "text", text: "STALE" }] } };
        yield { type: "result", subtype: "success", session_id: SESSION, result: "stale" };
        // Reached only when the driver pulls past the stale result: it has seen all of it.
        mark("stubborn:drained");
        return;
      }
      if (text === "perm" || text === "deaf") {
        const stop = interrupted();
        if (text === "perm") {
          // The CLI is parked on the PreToolUse hook: it answers an interrupt only after the hook does.
          let hookDone = () => {};
          interruptAnswer = new Promise((resolve) => { hookDone = resolve; });
          await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } });
          hookDone();
        } else {
          interruptAnswer = new Promise(() => {}); // a CLI that never answers the interrupt
          mark("deaf:running");
        }
        await stop;
        yield { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", session_id: SESSION };
        continue;
      }
      if (text === "/clear") {
        // O que o CLI de verdade faz (verificado com o SDK 0.3.246 em streaming, 2026-10-09): anuncia
        // o reset SEM campo "trigger" e ainda com o session_id ANTIGO, abre uma sessão NOVA (cujo id
        // não é o "new_conversation_id") e fecha o turno do comando com um result vazio.
        yield { type: "conversation_reset", new_conversation_id: "c4cc72ac-b5c3-4442-bc47-09159c6a1527", uuid: "8719ab21-dad0-493d-9e09-a26261eb6708", session_id: SESSION };
        yield { type: "system", subtype: "init", session_id: CLEARED };
        yield { type: "result", subtype: "success", session_id: CLEARED, result: "" };
        continue;
      }
      if (text === "bgstubborn") {
        // O stream DESERDADO que era dono do conjunto: anuncia uma tarefa, ignora interrupt e EOF, e
        // só depois de existir um stream mais novo anuncia o conjunto vazio — e fica pendurado.
        yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "x" }], session_id: SESSION, uuid: "u-bgs" };
        mark("bgstubborn:running");
        while (created === index) await sleep(20);
        yield { type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION, uuid: "u-bgs-off" };
        mark("bgstubborn:cleared");
        await new Promise(() => {});
      }
      if (text === "bg" || text === "bg-off" || text === "bg-die") {
        // TAREFAS EM SEGUNDO PLANO: o CLI anuncia o conjunto vivo inteiro a cada mudança
        // (system/background_tasks_changed, semântica de SUBSTITUIR).
        const tasks = text === "bg-off" ? [] : [{ task_id: "b1", task_type: "local_bash", description: "Aguarda o deploy" }];
        yield { type: "system", subtype: "background_tasks_changed", tasks, session_id: SESSION, uuid: "u-" + text };
        if (text === "bg-die") throw new Error("CLI process exited with code 1");
        yield { type: "result", subtype: "success", session_id: SESSION, result: "ok" };
        continue;
      }
      if (text === "sub") {
        // UM SUBAGENTE (Agent/Task) TRABALHANDO: o CLI repassa o stream e as mensagens dele com
        // parent_tool_use_id = o id da chamada que o disparou. A ÚLTIMA mensagem antes do result é
        // dele (uuid de sidechain) — o ponto de volta de um rebobinar não pode ser ela.
        yield { type: "assistant", uuid: "a-sub", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_use", id: "task1", name: "Agent", input: { description: "explora", subagent_type: "Explore" } },
        ] } };
        yield { type: "stream_event", parent_tool_use_id: "task1", session_id: SESSION, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "SUBTHINK" } } };
        yield { type: "stream_event", parent_tool_use_id: "task1", session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBDELTA" } } };
        yield { type: "assistant", uuid: "a-sub-child", parent_tool_use_id: "task1", session_id: SESSION, message: { content: [
          { type: "thinking", thinking: "SUBTHINKBLOCK" },
          { type: "text", text: "achei o arquivo" },
          { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/w/sdkChat.ts" } },
        ] } };
        yield { type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "content_block_delta", delta: { type: "text_delta", text: "MAINDELTA" } } };
        yield { type: "system", subtype: "background_tasks_changed", parent_tool_use_id: "task1", tasks: [], session_id: SESSION, uuid: "u-sub" };
        yield { type: "result", subtype: "success", session_id: SESSION, result: "ok" };
        continue;
      }
      if (text === "toolgen") {
        // UM WRITE GRANDE SENDO GERADO (formas do SDK 0.3.246, includePartialMessages): o bloco
        // tool_use abre, o input escorre em input_json_delta, e o turno PARA no gate — o tempo em
        // que o modelo ainda está escrevendo o arquivo. Um subagente faz o mesmo ao lado.
        const ev = (event, parent = null) => ({ type: "stream_event", parent_tool_use_id: parent, session_id: SESSION, event });
        yield ev({ type: "message_start", message: {} });
        yield ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } });
        yield ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "sub_1", name: "Write", input: {} } }, "task9");
        yield ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path": "/w/sub.ts"' } }, "task9");
        yield ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path": "/w/sdkChat.ts", "content": "' } });
        yield ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "x".repeat(4000) } });
        mark("toolgen:generating");
        while (!existsSync(join(options.cwd, "release-tool"))) await sleep(20);
        yield ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"}' } });
        yield ev({ type: "content_block_stop", index: 1 });
        yield { type: "assistant", uuid: "a-toolgen", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/w/sdkChat.ts", content: "x".repeat(4000) } },
        ] } };
        yield { type: "tool_progress", tool_use_id: "toolu_1", tool_name: "Write", parent_tool_use_id: null, elapsed_time_seconds: 3, uuid: "u-tp1", session_id: SESSION };
        yield { type: "tool_progress", tool_use_id: "sub_1", tool_name: "Write", parent_tool_use_id: "task9", elapsed_time_seconds: 5, uuid: "u-tp2", session_id: SESSION };
        yield { type: "result", subtype: "success", session_id: SESSION, result: "ok" };
        continue;
      }
      if (text.includes("slow")) {
        mark("slow:running");
        while (!existsSync(join(options.cwd, "release-slow"))) await sleep(20);
      }
      yield { type: "assistant", uuid: "a-" + text, message: { content: [{ type: "text", text: "reply:" + text }] } };
      yield { type: "result", subtype: "success", session_id: SESSION, result: "ok" };
    }
  }
  const handle = run();
  handle.interrupt = () => { onInterrupt(); return interruptAnswer; };
  handle.supportedCommands = async () => [];
  handle.initializationResult = async () => ({});
  handle.applyFlagSettings = async (settings) => { mark("flags:" + JSON.stringify(settings)); };
  return handle;
}
`;

type DriverEvent = { type: string } & Record<string, unknown>;

/**
 * Every wait below is for something the processes SAY, never for time to pass. The timeout is only
 * a ceiling for a hang: generous, because a loaded CI is slow, and nothing proves anything by
 * landing inside it.
 */
const CEILING_MS = 15_000;

interface RunningDriver {
  events: DriverEvent[];
  send(control: Record<string, unknown>): void;
  /** Resolves with the first event (from `from` on) that matches; rejects after {@link CEILING_MS}. */
  waitFor(match: (e: DriverEvent) => boolean, from?: number): Promise<DriverEvent>;
  /** Resolves once the fake SDK has printed `fake:<name>` (see FAKE_SDK). */
  waitMark(name: string): Promise<void>;
}

let sandbox = "";
let driverPath = "";
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "vibehub-sdk-driver-"));
  driverPath = join(sandbox, "sdk-driver.mjs");
  await copyFile(fileURLToPath(new URL("./sdk-driver.mjs", import.meta.url)), driverPath);
  const pkg = join(sandbox, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", type: "module", exports: "./index.mjs" }));
  await writeFile(join(pkg, "index.mjs"), FAKE_SDK);
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await rm(join(sandbox, "release-slow"), { force: true });
  await rm(join(sandbox, "release-tool"), { force: true });
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/** Opens the gate the fake SDK's "slow" turn is parked on. */
async function releaseSlowTurn(): Promise<void> {
  await writeFile(join(sandbox, "release-slow"), "");
}

/** A line-fed list that can be waited on: `wait` resolves with the first item (from `from` on) that matches. */
function waitableLines<T>(stream: NodeJS.ReadableStream, parse: (line: string) => T | null) {
  const items: T[] = [];
  const listeners = new Set<() => void>();
  createInterface({ input: stream }).on("line", (line) => {
    const item = parse(line);
    if (item === null) return;
    items.push(item);
    for (const notify of [...listeners]) notify();
  });
  const wait = (match: (item: T) => boolean, from: number, describeMiss: () => string): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = items.slice(from).find(match);
        if (hit === undefined) return;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`nothing matched within ${CEILING_MS}ms; ${describeMiss()}`));
      }, CEILING_MS);
      listeners.add(check);
      check();
    });
  return { items, wait };
}

function startDriver(extraArgs: string[] = []): RunningDriver {
  // CLAUDE_CONFIG_DIR with no `projects/`: the disk has no fork point, the memory one decides.
  const child = spawn(process.execPath, [driverPath, "--cwd", sandbox, ...extraArgs], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const events = waitableLines(child.stdout, (line) => JSON.parse(line) as DriverEvent);
  // stderr also carries the driver's own trace: only the fake SDK's `fake:` lines are marks.
  const marks = waitableLines(child.stderr, (line) => (line.startsWith("fake:") ? line.slice("fake:".length) : null));
  return {
    events: events.items,
    send: (control) => { child.stdin.write(JSON.stringify(control) + "\n"); },
    waitFor: (match, from = 0) =>
      events.wait(match, from, () => `got: ${events.items.map((e) => e.type).join(", ")}`),
    waitMark: async (name) => {
      await marks.wait((mark) => mark === name, 0, () => `marks: ${marks.items.join(", ")}`);
    },
  };
}

/** Boots a driver and finishes one ordinary turn — the memory fork point a rewind needs. */
async function driverAfterOneTurn(): Promise<RunningDriver> {
  const driver = startDriver();
  await driver.waitFor((e) => e.type === "ready");
  driver.send({ type: "user", text: "hello" });
  await driver.waitFor((e) => e.type === "result");
  return driver;
}

describe("sdk-driver.mjs — o stream que não soltou não manda mais em nada", () => {
  it("depois do teardown desistir, o stream velho só é drenado: nada de texto, de result nem de turno fechado no stream novo", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "stubborn" });
    await driver.waitMark("stubborn:running");
    driver.send({ type: "edit_user", original: "stubborn", text: "fixed slow", fallback: "fallback slow" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound.ok).toBe(true);
    // The new stream's turn is running (parked on the gate) and the old one has spoken and been
    // drained. A message now JOINS that turn — unless the stale result closed it behind the new
    // stream's back.
    await driver.waitMark("slow:running");
    await driver.waitMark("stubborn:drained");
    driver.send({ type: "user", text: "extra" });
    await driver.waitFor((e) => e.type === "turn_absorbed", from);
    await releaseSlowTurn();
    // stdout is one ordered pipe: a STALE text the driver let through would sit before this reply.
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:extra", from);

    const after = driver.events.slice(from);
    expect(after.filter((e) => e.type === "assistant_text").map((e) => e.text)).not.toContain("STALE");
    // The abandoned turn still owes the manager ONE result — paid when the teardown gave up, as an
    // abort, BEFORE the rewind: the manager counts turns by results, and a debt never paid leaves
    // the driver "busy" forever (no idle stop, the in-flight marker never cleared).
    const rewoundAt = after.findIndex((e) => e.type === "rewound");
    const owed = after.slice(0, rewoundAt).filter((e) => e.type === "result");
    expect(owed).toEqual([{ type: "result", subtype: "aborted", isError: false, sessionId: "11111111-2222-3333-4444-555555555555" }]);
  }, 60_000);
});

describe("sdk-driver.mjs — editar com um turno parado não espera minutos", () => {
  it("o rebobinar NEGA a permissão pendente antes de interromper — o CLI preso no hook não responde ao interrupt", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "perm" });
    await driver.waitFor((e) => e.type === "permission_request", from);
    driver.send({ type: "edit_user", original: "perm", text: "fixed", fallback: "fallback" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound.ok).toBe(true);
    // ORDER, not a stopwatch: the card was denied (not timed out) BEFORE the rewind — so the hook
    // returned and the CLI could answer the interrupt. Without the denial the rewind still lands,
    // but only after the teardown gives up on the interrupt, with the card left pending behind it
    // (and the 5-minute permission timeout is what would have released it).
    const after = driver.events.slice(from);
    const deniedAt = after.findIndex((e) => e.type === "permission" && e.decision === "deny");
    expect(deniedAt).toBeGreaterThanOrEqual(0);
    expect(deniedAt).toBeLessThan(after.findIndex((e) => e.type === "rewound"));
    expect(after[deniedAt]?.timedOut).toBe(false);
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:fixed", from);
  }, 60_000);

  it("um interrupt que nunca responde não segura o rebobinar (nem a fila de mensagens atrás dele)", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "deaf" });
    await driver.waitMark("deaf:running");
    driver.send({ type: "edit_user", original: "deaf", text: "fixed", fallback: "fallback" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound.ok).toBe(true);
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:fixed", from);
  }, 60_000);
});

describe("sdk-driver.mjs — tarefas em segundo plano", () => {
  it("repassa o conjunto VIVO de tarefas em segundo plano que o CLI anuncia, inclusive quando ele esvazia", async () => {
    const driver = startDriver();
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "bg" });
    const on = await driver.waitFor((e) => e.type === "background_tasks");
    expect(on.tasks).toEqual([{ id: "b1", type: "local_bash", description: "Aguarda o deploy" }]);
    const from = driver.events.length;
    driver.send({ type: "user", text: "bg-off" });
    const off = await driver.waitFor((e) => e.type === "background_tasks", from);
    expect(off.tasks).toEqual([]);
  });

  it("o teardown que DESISTE de um stream dono das tarefas zera o conjunto: o [] dele é só drenado, e ele pode nunca morrer", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "bgstubborn" });
    await driver.waitMark("bgstubborn:running");
    driver.send({ type: "edit_user", original: "bgstubborn", text: "fixed", fallback: "fallback" });
    await driver.waitMark("bgstubborn:cleared");
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:fixed", from);
    const sets = driver.events.slice(from).filter((e) => e.type === "background_tasks");
    expect(sets.at(-1)?.tasks).toEqual([]);
  }, 60_000);

  it("quando o processo do CLI morre, as tarefas morrem com ele: o conjunto volta vazio", async () => {
    const driver = startDriver();
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "bg-die" });
    await driver.waitFor((e) => e.type === "background_tasks" && Array.isArray(e.tasks) && e.tasks.length === 1);
    const off = await driver.waitFor((e) => e.type === "background_tasks" && Array.isArray(e.tasks) && e.tasks.length === 0);
    expect(off.tasks).toEqual([]);
  });
});

/**
 * O SUBAGENTE NÃO É O AGENTE PRINCIPAL. O driver ignorava `parent_tool_use_id`: o que um Agent/Task
 * fazia chegava na tela como se fosse o principal, e os deltas dele se misturavam à linha de
 * streaming do principal — a IA "parecia perdida".
 */
describe("sdk-driver.mjs — subagentes", () => {
  it("marca tool_use e assistant_text de subagente com parentToolUseId e não repassa os deltas dele", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "sub" });
    await driver.waitFor((e) => e.type === "result", from);
    const after = driver.events.slice(from);

    const tools = after.filter((e) => e.type === "tool_use");
    expect(tools).toEqual([
      { type: "tool_use", id: "task1", name: "Agent", input: { description: "explora", subagent_type: "Explore" } },
      { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/w/sdkChat.ts" }, parentToolUseId: "task1" },
    ]);
    expect(after.filter((e) => e.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: "achei o arquivo", parentToolUseId: "task1" },
    ]);
    // Os deltas do subagente não saem; os do principal, sim.
    expect(after.filter((e) => e.type === "assistant_delta").map((e) => e.text)).toEqual(["MAINDELTA"]);
    expect(after.filter((e) => e.type === "thinking_delta" || e.type === "thinking")).toEqual([]);
    // Mensagens de SESSÃO (system) continuam passando, mesmo vindas de dentro do subagente.
    expect(after.some((e) => e.type === "background_tasks")).toBe(true);
  });

  it("o ponto de volta de um rebobinar é a última mensagem do PRINCIPAL, nunca a de um subagente", async () => {
    const driver = await driverAfterOneTurn();
    const subFrom = driver.events.length;
    driver.send({ type: "user", text: "sub" });
    await driver.waitFor((e) => e.type === "result", subFrom);
    const from = driver.events.length;
    driver.send({ type: "user", text: "next" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:next", from);
    await driver.waitFor((e) => e.type === "result", from);
    driver.send({ type: "edit_user", original: "next", text: "next fixed", fallback: "fallback" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound.ok).toBe(true);
    expect(rewound.uuid).toBe("a-sub");
  }, 30_000);
});

/**
 * O CHAT MUDO NO WRITE GRANDE. O `tool_use` só saía quando o modelo terminava de gerar o input
 * inteiro: num arquivo de 400 linhas, dezenas de segundos de "Trabalhando…" sem um frame. Agora o
 * começo da ferramenta e o tamanho do input já gerado saem ENQUANTO o modelo escreve — e só do
 * agente principal, como os deltas de texto.
 */
describe("sdk-driver.mjs — ferramenta sendo gerada", () => {
  it("anuncia o tool_use e o progresso do input ANTES de o input inteiro chegar, só do principal", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "toolgen" });
    await driver.waitMark("toolgen:generating");
    // O gate segura o resto do input: o que chegou até aqui saiu durante a geração.
    const started = await driver.waitFor((e) => e.type === "tool_use_start", from);
    expect(started).toEqual({ type: "tool_use_start", id: "toolu_1", name: "Write" });
    const progress = await driver.waitFor((e) => e.type === "tool_input_progress" && e.filePath !== undefined, from);
    expect(progress).toMatchObject({ type: "tool_input_progress", id: "toolu_1", filePath: "/w/sdkChat.ts" });
    expect(progress.bytes).toBeGreaterThan(0);
    expect(driver.events.slice(from).some((e) => e.type === "tool_use")).toBe(false);

    await writeFile(join(sandbox, "release-tool"), "");
    await driver.waitFor((e) => e.type === "result", from);
    const after = driver.events.slice(from);
    // Nada do subagente: nem o começo, nem o progresso do input, nem o relógio da ferramenta.
    expect(after.filter((e) => e.type === "tool_use_start").map((e) => e.id)).toEqual(["toolu_1"]);
    expect(after.filter((e) => e.type === "tool_input_progress").every((e) => e.id === "toolu_1")).toBe(true);
    expect(after.filter((e) => e.type === "tool_progress")).toEqual([{ type: "tool_progress", id: "toolu_1", elapsedSeconds: 3 }]);
    // O começo vem antes do tool_use completo, e nenhum progresso de input vem depois dele.
    const full = after.findIndex((e) => e.type === "tool_use");
    expect(after.findIndex((e) => e.type === "tool_use_start")).toBeLessThan(full);
    expect(after.slice(full).some((e) => e.type === "tool_input_progress")).toBe(false);
  }, 30_000);
});

describe("sdk-driver.mjs — /clear", () => {
  it("repassa o reset da conversa e anuncia a sessão NOVA", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "/clear" });
    await driver.waitFor((e) => e.type === "result", from);
    const after = driver.events.slice(from);
    const reset = after.findIndex((e) => e.type === "conversation_reset");
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(after[reset]!.trigger).toBe("clear");
    // O PRIMEIRO `session` depois do reset já é o da sessão nova — nem o `new_conversation_id` nem o
    // `session_id` antigo que o próprio frame do reset carrega viram a sessão do card.
    expect(after.slice(reset).find((e) => e.type === "session")?.sessionId).toBe("99999999-2222-3333-4444-555555555555");
  });

  it("depois do /clear, editar uma mensagem de ANTES não rebobina para a conversa apagada", async () => {
    const driver = await driverAfterOneTurn(); // "hello" -> fork point da sessão antiga
    driver.send({ type: "user", text: "/clear" });
    await driver.waitFor((e) => e.type === "conversation_reset");
    await driver.waitFor((e) => e.type === "result" && e.sessionId === "99999999-2222-3333-4444-555555555555");
    const from = driver.events.length;
    driver.send({ type: "edit_user", original: "/clear", text: "/clear de novo", fallback: "fallback" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound.ok).toBe(false);
  }, 30_000);
});

describe("sdk-driver.mjs — a inteligência do card sobrevive ao ultrathink", () => {
  it("o --effort do card vai para o SDK, e o fim de um turno ultrathink DEVOLVE esse nível, não o padrão", async () => {
    // Medido no CLI de verdade (SDK 0.3.300, 2026-10-14): --effort low, flag max por cima e depois
    // flag null deixava a sessão em `medium` — o card perdia a escolha no primeiro ultrathink.
    const driver = startDriver(["--effort", "low"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "pensa nisso ultrathink" });
    await driver.waitMark("effort:low");
    await driver.waitMark('flags:{"effortLevel":"max"}');
    await driver.waitFor((e) => e.type === "result");
    await driver.waitMark('flags:{"effortLevel":"low"}');
  }, 60_000);

  it("sem inteligência no card, a devolução continua limpando a chave (o padrão da conta volta)", async () => {
    const driver = startDriver();
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "pensa nisso ultrathink" });
    await driver.waitMark("effort:none");
    await driver.waitFor((e) => e.type === "result");
    await driver.waitMark('flags:{"effortLevel":null}');
  }, 60_000);
});

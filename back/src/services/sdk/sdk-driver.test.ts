import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
let created = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (name) => process.stderr.write("fake:" + name + "\n");
const SESSION = "11111111-2222-3333-4444-555555555555";
const CLEARED = "99999999-2222-3333-4444-555555555555";

export function query({ prompt, options }) {
  const index = ++created;
  mark("effort:" + (options.effort ?? "none"));
  // Which sign-in this CLI was born with (the warm catalogue's throwaway CLI says so too).
  mark("auth:" + ((options.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN ?? "login"));
  let onInterrupt = () => {};
  let interruptAnswer = Promise.resolve();
  const interrupted = () => new Promise((resolve) => { onInterrupt = resolve; });
  if (options.forkSession) {
    // O /btw: uma consulta LATERAL, que bifurca a sessão e nunca escreve nela. Diz com que opções
    // nasceu, e responde com o que leu — "btwfail" simula o CLI caindo no meio.
    mark("btw:" + JSON.stringify({
      resume: options.resume ?? null,
      persist: options.persistSession,
      tools: options.tools,
      mcp: options.mcpServers,
      strict: options.strictMcpConfig,
      status: (options.env ?? {}).VIBEHUB_STATUS_URL,
      hooks: options.hooks ?? null,
    }));
    const handle = (async function* () {
      if (prompt.includes("btwfail")) throw new Error("CLI caiu");
      if (prompt.includes("btwslow")) while (!existsSync(join(options.cwd, "release-btw"))) await sleep(20);
      yield { type: "assistant", uuid: "a-btw", message: { content: [{ type: "text", text: "btw-reply:" + prompt }] } };
      yield { type: "result", subtype: "success", session_id: "fork-" + index, result: "ok" };
    })();
    handle.interrupt = async () => {};
    return handle;
  }
  async function* run() {
    // O SDK de verdade sobe o binário com spawn(cwd): pasta inexistente vira ENOENT, que ele relata
    // como "binário existe mas não subiu" e culpa a libc (produção, 2026-10-19).
    if (!existsSync(options.cwd)) {
      throw new ReferenceError("Claude Code native binary at /root/.vibehub-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude exists but failed to launch. This usually means the binary does not match this system's libc.");
    }
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
      if (text === "wake-die") {
        // O TURNO QUE O CLI ABRE SOZINHO: o turno da pessoa fecha, uma tarefa em segundo plano
        // termina e o CLI acorda o modelo sem mensagem nenhuma — e o processo cai no meio desse turno.
        yield { type: "result", subtype: "success", session_id: SESSION, result: "ok" };
        yield { type: "assistant", uuid: "a-wake", parent_tool_use_id: null, session_id: SESSION, message: { content: [{ type: "text", text: "acordei" }] } };
        throw new Error("CLI process exited with code 1");
      }
      if (text === "subslow") {
        // O CASO DO CARD e9146043 (29/10): um subagente em PRIMEIRO PLANO rodando — a chamada Agent
        // aberta, o turno parado nela — quando a inteligência é trocada. O gate é o mesmo do "slow".
        yield { type: "assistant", uuid: "a-subslow", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_use", id: "task-fg", name: "Agent", input: { description: "Implement Task 1", subagent_type: "general-purpose" } },
        ] } };
        mark("subslow:running");
        while (!existsSync(join(options.cwd, "release-slow"))) await sleep(20);
        yield { type: "user", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_result", tool_use_id: "task-fg", content: "Task 1 pronta" },
        ] } };
        yield { type: "assistant", uuid: "a-subslow-end", parent_tool_use_id: null, session_id: SESSION, message: { content: [{ type: "text", text: "etapa 1 aprovada" }] } };
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
      if (text === "hangtool") {
        // UMA FERRAMENTA PRESA (o vibehub_deliver de 24 min): o CLI só lê a próxima mensagem quando
        // ela devolve — este laço nem puxa o prompt seguinte antes disso, como o CLI de verdade
        // (medido no SDK, 2026-10-20). Só um interrupt a solta, com o "rejected" que o CLI escreve.
        const stop = interrupted();
        yield { type: "assistant", uuid: "a-hang", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_use", id: "toolu_hang", name: "mcp__vibehub__vibehub_deliver", input: {} },
        ] } };
        mark("hangtool:running");
        await stop;
        yield { type: "user", parent_tool_use_id: null, session_id: SESSION, message: { content: [
          { type: "tool_result", tool_use_id: "toolu_hang", is_error: true, content: "The user doesn't want to proceed with this tool use." },
        ] } };
        yield { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", session_id: SESSION };
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
  handle.interrupt = () => { mark("interrupt"); onInterrupt(); return interruptAnswer; };
  handle.supportedCommands = async () => [];
  handle.initializationResult = async () => ({});
  handle.applyFlagSettings = async (settings) => { mark("flags:" + JSON.stringify(settings)); };
  // O nível que a CONTA define (o effortLevel dos settings) vem de um arquivo no sandbox; sem ele, o
  // padrão do modelo ("medium", como o CLI de verdade para o Opus). \`applied\` é o que o CLI de
  // verdade diz que a próxima chamada vai usar: o --effort, senão os settings, senão o do modelo.
  handle.getSettings = async () => {
    const file = join(options.cwd, "account-effort");
    const own = existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
    return { applied: { effort: options.effort ?? own ?? "medium" }, effective: own ? { effortLevel: own } : {} };
  };
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
  /** Every `fake:` mark so far, in order. */
  marks: string[];
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
  await rm(join(sandbox, "release-btw"), { force: true });
  await rm(join(sandbox, "account-effort"), { force: true });
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

function startDriver(extraArgs: string[] = [], cwd = sandbox, configDir = sandbox): RunningDriver {
  // CLAUDE_CONFIG_DIR with no `projects/`: the disk has no fork point, the memory one decides.
  const child = spawn(process.execPath, [driverPath, "--cwd", cwd, ...extraArgs], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
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
    marks: marks.items,
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

/**
 * A MENSAGEM QUE NUNCA CHEGOU (produção, 2026-10-19): o turno morreu antes de o CLI gravá-la, a
 * pessoa edita, e o modelo recebia "[correção do usuário — desconsidere a mensagem anterior…]" sobre
 * uma mensagem que nunca leu. Com o transcript dizendo que ela não está no ramo vivo, a edição É a
 * mensagem: texto limpo, turno normal, sem rebobinar.
 */
describe("sdk-driver.mjs — editar uma mensagem que o modelo nunca leu", () => {
  it("vai o texto LIMPO, como mensagem normal, e o driver diz `not-delivered`", async () => {
    const config = join(sandbox, "profile-not-delivered");
    const projects = join(config, "projects", sandbox.replace(/[^A-Za-z0-9]/g, "-"));
    await mkdir(projects, { recursive: true });
    const entry = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: "s", ...o });
    await writeFile(join(projects, "11111111-2222-3333-4444-555555555555.jsonl"), [
      entry({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hello" } }),
      entry({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "oi" }] } }),
    ].join("\n") + "\n");
    const driver = startDriver([], sandbox, config);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "hello" });
    await driver.waitFor((e) => e.type === "result");
    const from = driver.events.length;

    driver.send({ type: "edit_user", original: "nunca chegou", text: "certa", fallback: "WRAPPED" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound).toEqual({ type: "rewound", ok: false, reason: "not-delivered" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:certa", from);
    const texts = driver.events.slice(from).filter((e) => e.type === "assistant_text").map((e) => e.text);
    expect(texts).not.toContain("reply:WRAPPED");
  }, 60_000);
});

/**
 * O BUG DO REENVIO (produção, 2026-10-19): a primeira mensagem morreu num erro de autenticação e foi
 * reenviada com as MESMAS palavras. Editar a primeira bolha procurava pelas palavras, achava a cópia
 * mais nova e rebobinava para depois da primeira resposta — "ficou como se eu tivesse editado a
 * segunda". Com `first`, não há o que procurar: nada antes dela fica, a conversa recomeça.
 */
/**
 * O LOGIN QUE SÓ VALIA DEPOIS DE "REINICIAR" (produção, 2026-10-19): o CLI nasce com o ambiente do
 * spawn e fica vivo entre as mensagens; a pessoa fazia `/login` e o chat seguia no token revogado
 * até alguém clicar em Reiniciar. O driver relê o perfil antes de cada envio e reabre o CLI quando
 * o login mudou — em segundo plano, na mesma sessão.
 */
describe("sdk-driver.mjs — um login novo vale na próxima mensagem, sem Reiniciar", () => {
  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r-1", expiresAt: 1 } });
  const authMarks = (driver: RunningDriver): string[] => driver.marks.filter((m) => m.startsWith("auth:"));

  async function profileWithToken(name: string): Promise<string> {
    const config = join(sandbox, name);
    await mkdir(config, { recursive: true });
    await writeFile(join(config, ".oauth-token"), "sk-revogado");
    const old = Date.now() / 1000 - 86_400;
    await utimes(join(config, ".oauth-token"), old, old);
    return config;
  }

  it("um /login feito com o driver de pé: a mensagem seguinte sobe um CLI novo, já no login", async () => {
    const config = await profileWithToken("profile-relogin");
    const driver = startDriver([], sandbox, config);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "hello" });
    await driver.waitFor((e) => e.type === "result");
    expect(authMarks(driver).at(-1)).toBe("auth:sk-revogado");
    const before = authMarks(driver).length;

    await writeFile(join(config, ".credentials.json"), LOGIN); // o /login, agora
    const from = driver.events.length;
    driver.send({ type: "user", text: "de novo" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:de novo", from);
    expect(authMarks(driver).length).toBe(before + 1);
    expect(authMarks(driver).at(-1)).toBe("auth:login");
    // Na mesma conversa: o CLI novo retoma a sessão, não abre outra.
    expect(driver.events.slice(from).some((e) => e.type === "error")).toBe(false);
  }, 60_000);

  it("nada mudou no perfil: o mesmo CLI segue, sem reabrir", async () => {
    const config = await profileWithToken("profile-same");
    const driver = startDriver([], sandbox, config);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "hello" });
    await driver.waitFor((e) => e.type === "result");
    const before = authMarks(driver).length;
    const from = driver.events.length;
    driver.send({ type: "user", text: "de novo" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:de novo", from);
    expect(authMarks(driver).length).toBe(before);
  }, 60_000);
});

describe("sdk-driver.mjs — editar a PRIMEIRA mensagem com uma cópia igual mais abaixo", () => {
  async function driverOnDuplicates(name: string) {
    const config = join(sandbox, name);
    const projects = join(config, "projects", sandbox.replace(/[^A-Za-z0-9]/g, "-"));
    await mkdir(projects, { recursive: true });
    const entry = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: "s", ...o });
    await writeFile(join(projects, "11111111-2222-3333-4444-555555555555.jsonl"), [
      entry({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "dup" } }),
      entry({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "erro" }] } }),
      entry({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "dup" } }),
      entry({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "erro" }] } }),
    ].join("\n") + "\n");
    const driver = startDriver([], sandbox, config);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "hello" });
    await driver.waitFor((e) => e.type === "result");
    return driver;
  }

  it("com `first`, recomeça a conversa (rewound ok SEM uuid) em vez de voltar para a segunda cópia", async () => {
    const driver = await driverOnDuplicates("profile-first-dup");
    const from = driver.events.length;
    driver.send({ type: "edit_user", original: "dup", text: "nova", fallback: "WRAPPED", first: true });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound).toEqual({ type: "rewound", ok: true, originalText: "dup" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:nova", from);
  }, 60_000);

  it("sem `first`, as palavras continuam achando a cópia mais nova (a regra de sempre, inalterada)", async () => {
    const driver = await driverOnDuplicates("profile-not-first-dup");
    const from = driver.events.length;
    driver.send({ type: "edit_user", original: "dup", text: "nova", fallback: "WRAPPED" });
    const rewound = await driver.waitFor((e) => e.type === "rewound", from);
    expect(rewound).toEqual({ type: "rewound", ok: true, uuid: "a1", originalText: "dup" });
  }, 60_000);
});

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

/**
 * O "ENVIAR AGORA" DA FILA (2026-10-20): a mensagem entrava no CLI, mas o CLI só a lê quando a
 * ferramenta em curso devolve — com um vibehub_deliver preso 24 min, a pessoa falava sozinha esse
 * tempo todo. Com ferramenta do principal rodando, `now` interrompe e entrega a mensagem como turno
 * NOVO; sem ferramenta rodando, o modelo a lê no passo seguinte e ela continua dobrando no turno.
 */
describe("sdk-driver.mjs — enviar agora", () => {
  it("com uma ferramenta presa, interrompe e o modelo responde à mensagem num turno próprio", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "hangtool" });
    await driver.waitMark("hangtool:running");
    await driver.waitFor((e) => e.type === "tool_use" && e.id === "toolu_hang", from);
    driver.send({ type: "user", text: "urgent", now: true });
    const reply = await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:urgent", from);
    await driver.waitFor((e) => e.type === "result", driver.events.indexOf(reply));
    const after = driver.events.slice(from);
    // Um turno próprio: dois results (o interrompido e o da mensagem), nenhum `turn_absorbed` —
    // o manager conta o +1 do envio e fecha nos dois results, sem spinner eterno nem fechado cedo.
    expect(after.filter((e) => e.type === "turn_absorbed")).toHaveLength(0);
    expect(after.filter((e) => e.type === "result")).toHaveLength(2);
    expect(after.find((e) => e.type === "result")?.isError).toBe(false); // interrompido não é falha
    expect(driver.marks).toContain("interrupt");
  }, 60_000);

  it("sem `now`, a mensagem continua esperando a ferramenta (nada é interrompido)", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "hangtool" });
    await driver.waitMark("hangtool:running");
    driver.send({ type: "user", text: "later" });
    await driver.waitFor((e) => e.type === "turn_absorbed", from);
    expect(driver.marks).not.toContain("interrupt");
  }, 60_000);

  it("com o modelo escrevendo (sem ferramenta rodando), `now` dobra no turno e não interrompe", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "user", text: "fold", now: true });
    await driver.waitFor((e) => e.type === "turn_absorbed", from);
    expect(driver.marks).not.toContain("interrupt");
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:fold", from);
  }, 60_000);

  it("a ferramenta que DEVOLVEU deixa de contar: `now` depois disso não interrompe", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "hangtool" });
    await driver.waitMark("hangtool:running");
    driver.send({ type: "interrupt" });
    await driver.waitFor((e) => e.type === "result", from);
    const marksBefore = driver.marks.filter((m) => m === "interrupt").length;
    driver.send({ type: "user", text: "slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "user", text: "fold", now: true });
    await driver.waitFor((e) => e.type === "turn_absorbed", from);
    expect(driver.marks.filter((m) => m === "interrupt")).toHaveLength(marksBefore);
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

describe("sdk-driver.mjs — o turno que o CLI abre sozinho", () => {
  // Produção, 2026-10-20: depois de uma retomada pós-deploy o CLI seguia num turno que ninguém
  // mandou (a tarefa em segundo plano terminou). O driver não sabia desse turno: se o stream caísse
  // no meio dele, nenhum `result` fechava — e o manager via o card "trabalhando" para sempre.
  it("o stream que cai no meio do turno autônomo fecha esse turno com o result `aborted` que ele deve", async () => {
    const driver = startDriver();
    await driver.waitFor((e) => e.type === "ready");
    const from = driver.events.length;
    driver.send({ type: "user", text: "wake-die" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "acordei", from);
    const owed = await driver.waitFor((e) => e.type === "result" && e.subtype === "aborted", from);
    expect(owed).toEqual({ type: "result", subtype: "aborted", isError: false, sessionId: "11111111-2222-3333-4444-555555555555" });
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

/**
 * A INTELIGÊNCIA TROCADA NO PILL COM O TURNO RODANDO (produção, 2026-10-27): ela esperava um
 * reinício que só vinha no fim do turno, e o turno seguia no nível velho. O `set_effort` entra na
 * sessão viva na hora — medido no CLI de verdade (SDK 0.3.300, 2026-10-27): `applyFlagSettings` no
 * meio do turno e as chamadas seguintes do MESMO turno saíram carimbadas no nível novo.
 */
describe("sdk-driver.mjs — a inteligência trocada com o turno rodando", () => {
  it("vai para a sessão viva NA HORA, sem esperar o turno acabar", async () => {
    const driver = startDriver(["--effort", "medium"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "revisa slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "set_effort", effort: "high" });
    await driver.waitMark('flags:{"effortLevel":"high"}');
    // Aplicado com o turno ainda aberto: nenhum result até aqui, nenhum stream novo.
    expect(driver.events.some((e) => e.type === "result")).toBe(false);
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "result");
  }, 60_000);

  it("sem stream de pé, o PRÓXIMO já nasce no nível novo", async () => {
    const driver = startDriver(["--effort", "medium"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "set_effort", effort: "xhigh" });
    driver.send({ type: "user", text: "oi" });
    await driver.waitMark("effort:xhigh");
    await driver.waitFor((e) => e.type === "result");
    // (O `effort:none` do boot é a consulta descartável do catálogo, que a primeira mensagem encerra.)
    expect(driver.marks.filter((m) => m.startsWith("effort:")).at(-1)).toBe("effort:xhigh");
  }, 60_000);

  it("um subagente em PRIMEIRO PLANO rodando: o nível entra na hora e a chamada dele volta no mesmo turno", async () => {
    // O relato do card e9146043 (29/10): Extra alto escolhido com a ferramenta Agent aberta. O que
    // não pode acontecer é a sessão cair e a chamada voltar como "session ended before this call's
    // result was recorded".
    const driver = startDriver(["--effort", "medium"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "subslow" });
    await driver.waitMark("subslow:running");
    driver.send({ type: "set_effort", effort: "xhigh" });
    await driver.waitMark('flags:{"effortLevel":"xhigh"}');
    expect(driver.events.some((e) => e.type === "result")).toBe(false);
    await releaseSlowTurn();
    const back = await driver.waitFor((e) => e.type === "tool_result" && e.id === "task-fg");
    expect(back.isError ?? false).toBe(false);
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "etapa 1 aprovada");
    await driver.waitFor((e) => e.type === "result");
    // Um stream só (o da conversa) além do descartável do catálogo: nada reiniciou.
    expect(driver.marks.filter((m) => m.startsWith("effort:"))).toEqual(["effort:none", "effort:medium"]);
  }, 60_000);

  it("voltar ao padrão da CONTA no meio do turno: limpa o flag e reaplica o nível dos settings, sem reiniciar", async () => {
    // O `null` do applyFlagSettings leva ao padrão do MODELO e ignora o effortLevel dos settings
    // (medido no CLI de verdade, SDK 0.3.300, 29/10: settings high → flag xhigh → null = medium).
    // O padrão da conta é o dos settings: ele volta por cima.
    await writeFile(join(sandbox, "account-effort"), "high");
    const driver = startDriver(["--effort", "xhigh"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "revisa slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "set_effort", effort: null });
    await driver.waitMark('flags:{"effortLevel":"high"}');
    expect(driver.marks.filter((m) => m.startsWith("flags:"))).toEqual(['flags:{"effortLevel":null}', 'flags:{"effortLevel":"high"}']);
    expect(driver.events.some((e) => e.type === "result")).toBe(false);
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "result");
  }, 60_000);

  it("voltar ao padrão sem nível nos settings: fica no do modelo (só o null)", async () => {
    const driver = startDriver(["--effort", "xhigh"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "revisa slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "set_effort", effort: null });
    await driver.waitMark('flags:{"effortLevel":null}');
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "result");
    expect(driver.marks.filter((m) => m.startsWith("flags:"))).toEqual(['flags:{"effortLevel":null}']);
  }, 60_000);

  it("voltar ao padrão sem stream de pé: o próximo nasce sem --effort", async () => {
    const driver = startDriver(["--effort", "xhigh"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "set_effort", effort: null });
    driver.send({ type: "user", text: "oi" });
    await driver.waitFor((e) => e.type === "result");
    expect(driver.marks.filter((m) => m.startsWith("effort:")).at(-1)).toBe("effort:none");
  }, 60_000);

  it("um turno ultrathink em voo segura o max; a devolução no fim dele já é o nível novo", async () => {
    const driver = startDriver(["--effort", "low"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "pensa nisso ultrathink slow" });
    await driver.waitMark('flags:{"effortLevel":"max"}');
    await driver.waitMark("slow:running");
    driver.send({ type: "set_effort", effort: "high" });
    // Com o max segurado, o set_effort não deixa rastro: soltar o turno logo em seguida corria com a
    // leitura do stdin, e sob carga o turno acabava antes, devolvia o "low" (certo, para uma troca
    // DEPOIS do turno) e o teste falhava. O driver lê o stdin em ordem e na hora: a resposta a uma
    // linha seguinte prova que o set_effort já foi lido.
    driver.send({ type: "permission_decision", id: "barreira-effort", allow: false });
    await driver.waitFor((e) => e.type === "error" && String(e.message).includes("barreira-effort"));
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "result");
    await driver.waitMark('flags:{"effortLevel":"high"}');
    // O max do ultrathink não foi cortado no meio do turno, e o nível velho não volta.
    const flags = driver.marks.filter((m) => m.startsWith("flags:"));
    expect(flags).toEqual(['flags:{"effortLevel":"max"}', 'flags:{"effortLevel":"high"}']);
  }, 60_000);

  it("um nível que não existe não chega ao CLI", async () => {
    const driver = startDriver(["--effort", "medium"]);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "revisa slow" });
    await driver.waitMark("slow:running");
    driver.send({ type: "set_effort", effort: "turbo" });
    driver.send({ type: "set_effort", effort: "low" });
    await driver.waitMark('flags:{"effortLevel":"low"}');
    expect(driver.marks.filter((m) => m.startsWith("flags:"))).toEqual(['flags:{"effortLevel":"low"}']);
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "result");
  }, 60_000);
});

/**
 * O NÍVEL ANTES DA PRIMEIRA RESPOSTA (29/10): num card sem nível fixado, nada dizia em qual a sessão
 * ia rodar até a primeira resposta carimbar o transcript — o pill mostrava só "Opus". O CLI responde
 * isso sem turno nenhum (`getSettings().applied.effort`, medido no SDK 0.3.300), então a consulta
 * descartável do catálogo já pergunta e o driver anuncia o padrão da conta.
 */
describe("sdk-driver.mjs — o nível padrão da conta, anunciado no boot", () => {
  it("sai antes de qualquer mensagem, e é o da CONTA mesmo com o card fixado em outro", async () => {
    const driver = startDriver(["--effort", "xhigh"]);
    const def = await driver.waitFor((e) => e.type === "effort_default");
    expect(def.effort).toBe("medium");
    expect(driver.events.some((e) => e.type === "result")).toBe(false);
    // A consulta descartável sobe sem o nível do card: é ela que diz o padrão.
    expect(driver.marks.filter((m) => m.startsWith("effort:"))).toEqual(["effort:none"]);
  }, 60_000);

  it("o effortLevel dos settings da conta é o padrão", async () => {
    await writeFile(join(sandbox, "account-effort"), "high");
    const driver = startDriver();
    const def = await driver.waitFor((e) => e.type === "effort_default");
    expect(def.effort).toBe("high");
  }, 60_000);
});

describe("sdk-driver.mjs — a pasta do card sumiu", () => {
  it("diz que a pasta de trabalho não existe mais, em vez do erro de libc do SDK", async () => {
    const gone = join(sandbox, "worktree-removida");
    const driver = startDriver([], gone);
    await driver.waitFor((e) => e.type === "ready");
    driver.send({ type: "user", text: "hello" });
    const error = await driver.waitFor((e) => e.type === "error");
    expect(error.message).toContain(gone);
    expect(error.message).toMatch(/não existe mais/);
    expect(error.message).not.toMatch(/libc/);
    // O turno fecha: sem isso o "Trabalhando…" girava para sempre.
    await driver.waitFor((e) => e.type === "result");
  }, 60_000);
});

/**
 * O /btw: a pessoa pergunta algo enquanto o turno roda, e a resposta vem de uma consulta LATERAL —
 * a sessão bifurcada (o contexto todo), sem ferramentas, sem gravar nada na sessão de verdade e sem
 * tocar no turno em andamento.
 */
describe("sdk-driver.mjs — /btw", () => {
  it("responde com o turno rodando, sem interrompê-lo, numa bifurcação sem ferramentas", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "user", text: "slow" });
    await driver.waitMark("slow:running");

    driver.send({ type: "btw", id: "b1", question: "o que falta?" });
    const answer = await driver.waitFor((e) => e.type === "btw_answer", from);
    expect(answer.id).toBe("b1");
    expect(answer.question).toBe("o que falta?");
    expect(String(answer.text)).toContain("btw-reply:");
    expect(String(answer.text)).toContain("o que falta?");
    expect(answer.error).toBeUndefined();

    const opts = JSON.parse(driver.marks.find((m) => m.startsWith("btw:"))!.slice("btw:".length)) as Record<string, unknown>;
    expect(opts).toMatchObject({
      resume: "11111111-2222-3333-4444-555555555555",
      persist: false,
      tools: [],
      mcp: {},
      strict: true,
      status: "",
      hooks: null,
    });
    expect(driver.marks).not.toContain("interrupt");

    // O turno de verdade segue e fecha sozinho.
    await releaseSlowTurn();
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:slow", from);
  }, 60_000);

  it("UMA pergunta lateral por vez: a segunda espera a primeira responder", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "btw", id: "lenta", question: "btwslow" });
    driver.send({ type: "btw", id: "rapida", question: "e esta?" });
    while (!driver.marks.some((m) => m.startsWith("btw:"))) await new Promise((resolve) => setTimeout(resolve, 20));
    // A ausência não tem evento para esperar: uma folga curta, e a prova de verdade é a ordem abaixo.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(driver.marks.filter((m) => m.startsWith("btw:"))).toHaveLength(1);
    expect(driver.events.slice(from).some((e) => e.type === "btw_answer")).toBe(false);

    await writeFile(join(sandbox, "release-btw"), "");
    const second = await driver.waitFor((e) => e.type === "btw_answer" && e.id === "rapida", from);
    const answers = driver.events.slice(from).filter((e) => e.type === "btw_answer").map((e) => e.id);
    expect(answers).toEqual(["lenta", "rapida"]);
    expect(String(second.text)).toContain("e esta?");
  }, 60_000);

  it("fila com teto: a pergunta além dele é recusada NA HORA, as outras seguem", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    for (const id of ["q1", "q2", "q3", "q4"]) driver.send({ type: "btw", id, question: "btwslow " + id });
    const refused = await driver.waitFor((e) => e.type === "btw_answer" && e.id === "q4", from);
    expect(String(refused.error)).toMatch(/fila/);
    expect(driver.events.slice(from).filter((e) => e.type === "btw_answer")).toHaveLength(1);

    await writeFile(join(sandbox, "release-btw"), "");
    await driver.waitFor((e) => e.type === "btw_answer" && e.id === "q3", from);
    const answered = driver.events.slice(from).filter((e) => e.type === "btw_answer" && e.text).map((e) => e.id);
    expect(answered).toEqual(["q1", "q2", "q3"]);
  }, 60_000);

  it("uma falha vira resposta com erro — nunca derruba o driver", async () => {
    const driver = await driverAfterOneTurn();
    const from = driver.events.length;
    driver.send({ type: "btw", id: "b2", question: "btwfail" });
    const answer = await driver.waitFor((e) => e.type === "btw_answer", from);
    expect(answer).toMatchObject({ id: "b2", question: "btwfail" });
    expect(String(answer.error)).toContain("CLI caiu");
    driver.send({ type: "user", text: "depois" });
    await driver.waitFor((e) => e.type === "assistant_text" && e.text === "reply:depois", from);
  }, 60_000);
});

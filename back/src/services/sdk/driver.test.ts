import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostExecutor, type HostExecutor } from "../../runtime/host.js";
import type { Card, Project } from "../board/registry.js";
import {
  buildSdkDriverCommandLine,
  buildInstallDriverScript,
  buildEnsureSdkScript,
  installCardSdkDriver,
  sdkDriverCommand,
  SDK_DRIVER_PATH,
  SDK_DRIVER_DIR,
  SDK_PACKAGE_VERSION,
  SDK_VERSION_MARKER,
} from "./driver.js";

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));
vi.mock("../settings/settings.js", () => ({ getSettings: vi.fn(async () => ({ sdkPermissionMode: "ask-sensitive" })) }));

describe("sdkDriverCommand — o driver fala NDJSON por pipes, nunca por um tty", () => {
  afterEach(() => vi.mocked(hostExecutor).mockReset());

  it("usa o transporte de PIPE do executor (no ssh, o de pty põe -tt: eco, CRLF e linha > 4095 bytes cortada)", async () => {
    // The two transports as the ssh executor builds them: what tells them apart is the tty.
    vi.mocked(hostExecutor).mockReturnValue({
      ptyCommand: (line: string) => ({ file: "ssh", args: ["-tt", "runner", line] }),
      pipeCommand: (line: string) => ({ file: "ssh", args: ["runner", line] }),
    } as unknown as HostExecutor);
    const project = { id: "p1", name: "scratch" } as unknown as Project;
    const card = { id: "card-0001", projectId: "p1", worktreeSlug: "card-0001" } as unknown as Card;
    const { file, args } = await sdkDriverCommand(project, card);
    expect(file).toBe("ssh");
    expect(args).not.toContain("-tt");
    expect(args[args.length - 1]).toContain("exec node");
  });
});

describe("buildSdkDriverCommandLine", () => {
  const base = { containerName: "vibehub-runner", cwd: "/work/o--r-worktrees/card-1", profileDir: "/root/.claude" };

  it("wraps a `docker exec -i` (no tty) so stdio stays clean pipes for NDJSON", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("'docker' 'exec' '-i' 'vibehub-runner' 'bash' '-c'");
    expect(line).not.toContain("-it");
  });

  it("exports the OAuth token from the profile's .oauth-token, like the TUI guard", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("/root/.claude/.oauth-token");
    expect(line).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(line).toContain("IS_SANDBOX=1");
  });

  it("points NODE_PATH at the driver dir's node_modules and runs the driver with --cwd", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain(`${SDK_DRIVER_DIR}/node_modules`);
    expect(line).toContain(SDK_DRIVER_PATH);
    expect(line).toContain("--cwd");
    expect(line).toContain("/work/o--r-worktrees/card-1");
  });

  it("adds --resume for a valid session id and --model for a whitelisted model", () => {
    const line = buildSdkDriverCommandLine({
      ...base,
      resumeSessionId: "0d1b3864-4870-4141-8451-79d73de0bd96",
      model: "opus",
    });
    expect(line).toContain("--resume");
    expect(line).toContain("0d1b3864-4870-4141-8451-79d73de0bd96");
    expect(line).toContain(String.raw`--model '\''opus'\''`);
  });

  it("a versioned id pinned by an older vibehub reaches the driver as its family", () => {
    const line = buildSdkDriverCommandLine({ ...base, model: "claude-opus-5" });
    expect(line).toContain(String.raw`--model '\''opus'\''`);
    expect(line).not.toContain("claude-opus-5");
  });

  it("drops an invalid model rather than passing raw input to the shell", () => {
    const line = buildSdkDriverCommandLine({ ...base, model: "; rm -rf / #" });
    expect(line).not.toContain("--model");
    expect(line).not.toContain("rm -rf");
  });

  it("adds --effort for a whitelisted level and drops anything else", () => {
    expect(buildSdkDriverCommandLine({ ...base, effort: "xhigh" })).toContain(String.raw`--effort '\''xhigh'\''`);
    const bad = buildSdkDriverCommandLine({ ...base, effort: "high; id" });
    expect(bad).not.toContain("--effort");
    expect(bad).not.toContain("; id");
  });

  it("threads CLAUDE_CONFIG_DIR only for a non-default account", () => {
    expect(buildSdkDriverCommandLine(base)).not.toContain("CLAUDE_CONFIG_DIR");
    const withAcct = buildSdkDriverCommandLine({ ...base, configDir: "/root/.claude-profiles/work", profileDir: "/root/.claude-profiles/work" });
    expect(withAcct).toContain("CLAUDE_CONFIG_DIR");
    expect(withAcct).toContain("/root/.claude-profiles/work");
  });

  it("rejects a session id that is not a uuid (never reaches the shell)", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, resumeSessionId: "$(evil)" })).toThrow();
  });

  it("rejects an unsafe cwd", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, cwd: "/work/../etc" })).toThrow();
  });

  it("exports the card environment the TUI session also carries (browser endpoint + status hooks)", () => {
    const line = buildSdkDriverCommandLine({
      ...base,
      cdpEndpoint: "http://127.0.0.1:39222",
      cardId: "card-0001",
      statusUrl: "https://hub.example.com/api/runner/status",
    });
    expect(line).toContain("PW_CDP_ENDPOINT=");
    expect(line).toContain("http://127.0.0.1:39222");
    expect(line).toContain("VIBEHUB_CARD_ID=");
    expect(line).toContain("card-0001");
    expect(line).toContain("VIBEHUB_STATUS_URL=");
    expect(line).toContain("https://hub.example.com/api/runner/status");
    // Without them, nothing is exported — a driver spawned by an older path stays valid.
    const bare = buildSdkDriverCommandLine(base);
    expect(bare).not.toContain("PW_CDP_ENDPOINT");
    expect(bare).not.toContain("VIBEHUB_CARD_ID");
  });

  it("exports the card's git include — the native chat's git acts as the card's author in ANY repository", () => {
    const line = buildSdkDriverCommandLine({ ...base, cardId: "card-0001" });
    // The PATH, never a token: the identity behind it is rewritten in the file on every author switch.
    expect(line).toContain("GIT_CONFIG_COUNT=");
    expect(line).toContain("GIT_CONFIG_KEY_0=");
    expect(line).toContain("include.path");
    expect(line).toContain("GIT_CONFIG_VALUE_0=");
    expect(line).toContain("/root/.vibehub/git/card-0001.gitconfig");
    // A token exported at spawn would be frozen there — the gh wrapper reads the card's file instead.
    expect(line).not.toContain("GH_TOKEN");
    expect(buildSdkDriverCommandLine(base)).not.toContain("GIT_CONFIG_COUNT");
  });

  it("caps test-runner workers in every driver session — the runner's cores are shared by all cards", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("export VITEST_MAX_THREADS=2; ");
    expect(line).toContain("export VITEST_MAX_FORKS=2; ");
  });

  it("rejects an unsafe cdp/status URL or card id rather than passing it to the shell", () => {
    expect(() => buildSdkDriverCommandLine({ ...base, cdpEndpoint: "http://x'; rm -rf /" })).toThrow();
    expect(() => buildSdkDriverCommandLine({ ...base, statusUrl: "ftp://nope" })).toThrow();
    expect(() => buildSdkDriverCommandLine({ ...base, cardId: "c1; evil" })).toThrow();
  });

  it("threads the permission-gate mode as a driver flag", () => {
    const same = buildSdkDriverCommandLine({ ...base, permissionGate: "same-as-terminal" });
    expect(same).toContain("--permission-gate");
    expect(same).toContain("same-as-terminal");
    const ask = buildSdkDriverCommandLine({ ...base, permissionGate: "ask-sensitive" });
    expect(ask).toContain("--permission-gate");
    expect(ask).toContain("ask-sensitive");
    expect(buildSdkDriverCommandLine(base)).not.toContain("--permission-gate");
  });
});

describe("buildInstallDriverScript", () => {
  it("plants the driver atomically (tmp + chmod + mv) via docker exec, source in a quoted heredoc", () => {
    const script = buildInstallDriverScript("vibehub-runner", "console.log('hi')\n");
    expect(script).toContain("docker exec -i 'vibehub-runner' bash -s");
    expect(script).toContain(`mkdir -p '${SDK_DRIVER_DIR}'`);
    expect(script).toContain('chmod 755 "$tmp"');
    expect(script).toContain(`mv -f "$tmp" '${SDK_DRIVER_PATH}'`);
    expect(script).toContain("console.log('hi')");
    // quoted heredoc delimiter => the source is written literally, not expanded
    expect(script).toContain("<<'VIBEHUB_SDK_DRIVER_SRC'");
  });

  it("each install writes its OWN tmp file — two installs at once never share (nor steal) one", () => {
    // A deploy knocks down every driver and the tabs reconnect together: with a fixed `.tmp`, the
    // second install truncated the file the first one was writing and hit ENOENT on the
    // chmod/mv of the tmp the first one had already moved (set -e) — "could not install the driver".
    const script = buildInstallDriverScript("vibehub-runner", "x\n");
    expect(script).toContain(`tmp="$(mktemp '${SDK_DRIVER_PATH}.XXXXXX')"`);
    expect(script).not.toContain(`'${SDK_DRIVER_PATH}.tmp'`);
  });
});

describe("installCardSdkDriver — uma instalação por vez (single-flight)", () => {
  let runScript: ReturnType<typeof vi.fn>;
  /** Releases every script still parked (each one waits for the test, like a slow runner). */
  let release: () => void = () => {};

  beforeEach(() => {
    runScript = vi.fn(() => new Promise((resolve) => {
      const previous = release;
      release = () => { previous(); resolve({ stdout: "", stderr: "" }); };
    }));
    vi.mocked(hostExecutor).mockReturnValue({ runScript } as unknown as HostExecutor);
  });
  afterEach(() => {
    release = () => {};
    vi.mocked(hostExecutor).mockReset();
  });

  /** Lets the install in flight walk through its scripts (each step awaits the previous one). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      const pending = release;
      release = () => {};
      pending();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("connects que se sobrepõem DIVIDEM a instalação em voo — N abas não viram N npm install no mesmo node_modules", async () => {
    const all = Promise.all([installCardSdkDriver(), installCardSdkDriver(), installCardSdkDriver()]);
    await drain();
    await all;
    // one exec (plant + ensure), not three
    expect(runScript).toHaveBeenCalledTimes(1);
    const script = String(runScript.mock.calls[0]![0]);
    expect(script.indexOf(SDK_DRIVER_PATH)).toBeLessThan(script.indexOf("npm install"));
  });

  it("uma instalação TERMINADA não fica em cache: o próximo connect confere de novo (o marcador deixa isso barato)", async () => {
    const first = installCardSdkDriver();
    await drain();
    await first;
    const second = installCardSdkDriver();
    await drain();
    await second;
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it("uma instalação que FALHOU falha para todos que esperavam, e o connect seguinte tenta de novo", async () => {
    runScript.mockImplementationOnce(() => Promise.reject(new Error("runner down")));
    const a = installCardSdkDriver();
    const b = installCardSdkDriver();
    await expect(a).rejects.toThrow("runner down");
    await expect(b).rejects.toThrow("runner down");
    expect(runScript).toHaveBeenCalledTimes(1);
    const retry = installCardSdkDriver();
    await drain();
    await retry;
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it("uma falha SÍNCRONA (antes do primeiro await) também não fica em cache", async () => {
    // The async body runs synchronously up to the first await: if the executor (or reading the
    // driver's source) blows up there, the finally runs BEFORE the set in the map — and the rejected
    // promise stayed stored as "in flight" forever: every later connect got the same old failure.
    vi.mocked(hostExecutor).mockImplementationOnce(() => { throw new Error("no executor"); });
    await expect(installCardSdkDriver()).rejects.toThrow("no executor");
    const retry = installCardSdkDriver();
    await drain();
    await retry;
    expect(runScript).toHaveBeenCalledTimes(1);
  });
});

describe("auth hygiene — CLAUDE_CODE_OAUTH_TOKEN only (project rule)", () => {
  const base = { containerName: "vibehub-runner", cwd: "/work/o--r-worktrees/card-1", profileDir: "/root/.claude" };

  it("UNSETS ANTHROPIC_API_KEY before anything else, so an inherited key can never win over the token", () => {
    const line = buildSdkDriverCommandLine(base);
    expect(line).toContain("unset ANTHROPIC_API_KEY");
    // the unset comes BEFORE the exec of node — it is environment prep, not an afterthought
    expect(line.indexOf("unset ANTHROPIC_API_KEY")).toBeLessThan(line.indexOf("exec node"));
    // and the command never EXPORTS an API key of its own
    expect(line).not.toContain("export ANTHROPIC_API_KEY");
  });

  it("the driver source itself deletes ANTHROPIC_API_KEY (second lock on the same door)", async () => {
    const { sdkDriverSource } = await import("./driver.js");
    expect(sdkDriverSource()).toContain("delete process.env.ANTHROPIC_API_KEY");
  });
});

describe("buildEnsureSdkScript — the automatic, idempotent SDK install", () => {
  it("installs the pinned SDK only when the version marker disagrees (idempotent by marker)", () => {
    const script = buildEnsureSdkScript("vibehub-runner");
    expect(script).toContain("docker exec -i 'vibehub-runner' bash -s");
    // the guard: marker equal + package dir present => the whole install is skipped
    expect(script).toContain(`cat '${SDK_VERSION_MARKER}'`);
    expect(script).toContain(`!= '${SDK_PACKAGE_VERSION}'`);
    expect(script).toContain("node_modules/@anthropic-ai/claude-agent-sdk");
    // the install pins the exact version and writes the marker AFTER installing
    expect(script).toContain(`'@anthropic-ai/claude-agent-sdk@${SDK_PACKAGE_VERSION}'`);
    expect(script.indexOf("npm install")).toBeLessThan(script.indexOf(`printf '%s' '${SDK_PACKAGE_VERSION}'`));
  });

  it("never touches the container itself — only /root/.vibehub-sdk", () => {
    const script = buildEnsureSdkScript("vibehub-runner");
    expect(script).not.toContain("docker run");
    expect(script).not.toContain("docker rm");
    expect(script).toContain(SDK_DRIVER_DIR);
  });

  it("rejects a malformed version rather than passing it to npm", () => {
    expect(() => buildEnsureSdkScript("vibehub-runner", "1.2; rm -rf /")).toThrow();
  });
});

/**
 * THE DRIVER IS NOT IMPORTABLE (it is an .mjs that runs inside the runner, where the SDK is installed), so
 * what can be pinned here is ITS TEXT. It is not fussiness: this stretch has two traps that
 * make no noise at all when they break.
 *
 * 1. `display: "summarized"` — on current models the default is `omitted`, and then the thinking blocks
 *    arrive EMPTY. Without this line the driver keeps "working", emitting nothing, and the screen goes
 *    back to showing only the spinner: a silent disappearance, the kind that only shows up in production.
 * 2. The delta carries the text in `delta.thinking`, NOT in `delta.text` (the Messages API's
 *    ThinkingDelta). Copying the text line and changing the type returns `undefined` on every token.
 */
describe("sdk-driver.mjs — o raciocínio que a tela mostra", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  it("pede o raciocínio ao SDK com display 'summarized' (o padrão 'omitted' vem vazio)", () => {
    expect(source).toMatch(/thinking:\s*\{\s*type:\s*"adaptive",\s*display:\s*"summarized"\s*\}/);
  });

  it("encaminha o delta ao vivo lendo `delta.thinking` (não `delta.text`)", () => {
    expect(source).toContain('ev.delta.type === "thinking_delta"');
    expect(source).toContain('emit({ type: "thinking_delta", text: ev.delta.thinking })');
  });

  it("encaminha o bloco consolidado, e só quando ele tem texto", () => {
    expect(source).toContain('block.type === "thinking"');
    expect(source).toContain('emit({ type: "thinking", text: block.thinking })');
  });

  it("não inventa linha para `redacted_thinking` — ele não carrega texto legível", () => {
    expect(source).not.toContain('emit({ type: "thinking", text: block.data');
  });
});

/**
 * THE "/" MENU OF A NEW CARD (production, 26/09/2026): open a card, type "/code-re" and be
 * offered nothing. The catalog came only from `init`, which only happens when a turn starts — so the
 * freshly opened card, which is exactly where one wants to pick a command, was left with no menu.
 *
 * The `.mjs` is not importable, so what gets pinned is the text — and there are three silent traps here:
 * asking for the catalog without closing the throwaway query would leave one live CLI per card; letting
 * `VIBEHUB_STATUS_URL` through would make the SessionStart hook send status for a card with no turn
 * at all; and setting `catalogAnnounced` here would freeze the provisional catalog (no skill/plugin) in
 * place of the complete one the first `init` brings.
 */
describe("sdk-driver.mjs — o menu \"/\" antes da primeira mensagem", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  it("pergunta o catálogo ao CLI assim que o driver sobe", () => {
    expect(source).toContain("void warmCatalog();");
    expect(source).toContain("await handle.supportedCommands()");
  });

  it("não deixa a consulta descartável mandar status do card (hook de SessionStart)", () => {
    expect(source).toContain('options.env = { ...process.env, VIBEHUB_STATUS_URL: "" };');
  });

  it("encerra a consulta descartável — nada de um CLI a mais vivo por card", () => {
    expect(source).toMatch(/finally\s*\{\s*\n\s*ch\.end\(\);/);
    expect(source).toContain("if (warmChannel) warmChannel.end();");
  });

  it("sobe sem MCP nenhum — no reinício eram dez CLIs descartáveis lançando npx e conexões", () => {
    expect(source).toContain("options.strictMcpConfig = true;");
    expect(source).toContain("options.mcpServers = {};");
  });

  it("a mensagem de verdade mata o CLI descartável (abort), não espera ele terminar de subir", () => {
    expect(source).toContain("options.abortController = abort;");
    expect(source).toMatch(/if \(warmChannel\) warmChannel\.end\(\);\s*\n\s*if \(warmAbort\) warmAbort\.abort\(\);/);
  });

  it("não marca o catálogo como anunciado: o `init` de verdade ainda substitui este", () => {
    expect(source).toContain("if (catalogAnnounced || channel || warmChannel) return;");
    expect(source).not.toMatch(/warmCatalog[\s\S]{0,800}catalogAnnounced = true/);
  });
});

/**
 * THE MESSAGE THAT UNBLOCKS THE CARD (production, 2026-09-17): with an options plan on screen, writing
 * in the chat did nothing — the turn was stopped inside `canUseTool` and the message sat in the CLI's
 * queue until the 30-minute timeout. The `.mjs` is not importable, so what gets pinned is the text: the
 * two traps here are the ORDER (releasing before pushing lets the turn go on without reading the
 * message — the opposite of what the person asked) and the message the model reads instead of the choice.
 */
describe("sdk-driver.mjs — falar é responder (o cartão de pergunta não prende mais)", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  it("uma mensagem do usuário libera as perguntas pendentes", () => {
    expect(source).toContain("function supersedePendingQuestions()");
    expect(source).toContain("superseded: true");
    expect(source).toContain("supersedePendingQuestions();");
  });

  it("a mensagem entra na corrente ANTES de o cartão ser liberado (ordem é o bug)", () => {
    const handler = source.slice(source.indexOf('control.type === "user"'));
    const push = handler.indexOf("sendUser(control.text);");
    const release = handler.indexOf("supersedePendingQuestions();");
    expect(push).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(push);
  });

  it("o modelo é instruído a LER a mensagem e a não repetir a pergunta", () => {
    expect(source).toContain("QUESTION_SUPERSEDED_MESSAGE");
    expect(source).toContain("SUPERSEDES this question");
    expect(source).toContain("do not ask it again");
  });

  it("o resultado do cartão sai marcado como substituído (a tela não pode dizer 'sem resposta')", () => {
    expect(source).toContain('emit({ type: "question_result", id, timedOut: !!timedOut, superseded: !!superseded })');
  });
});

/**
 * THE TWO RESERVED WORDS. `ultrathink` and `ultracode` are not text: the CLI reads both from what
 * you write and acts — the first asks for deeper reasoning in the turn, the second opts the turn into
 * multi-agent orchestration. What the CLI does NOT do is raise the effort LEVEL, and that is what the
 * panel promises when it paints the word in the composer; the driver is the one that delivers.
 *
 * The `.mjs` is not importable, so the detection — which must match EXACTLY
 * `front/src/features/board/lib/ultraWords.ts`, otherwise the screen paints a word the back ignores —
 * is cut out of the source and executed here. The rest are wiring invariants, including the only one
 * that can be costly: the message has to be pushed even when the escalation fails.
 */
describe("sdk-driver.mjs — ultrathink / ultracode", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** The detection, cut out of the driver and actually executed. */
  const ultraKeywords = ((): ((text: string) => { ultrathink: boolean; ultracode: boolean; any: boolean }) => {
    const from = source.indexOf("const ULTRA_CLOSERS");
    const to = source.indexOf("let ultraRaised"); // the detection ends where the escalation state begins
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const factory = new Function(`${source.slice(from, to)}\nreturn ultraKeywords;`);
    return factory() as (text: string) => { ultrathink: boolean; ultracode: boolean; any: boolean };
  })();

  it("lê as duas palavras em qualquer caixa", () => {
    expect(ultraKeywords("faz ULTRATHINK nisso")).toEqual({ ultrathink: true, ultracode: false, any: true });
    expect(ultraKeywords("manda UltraCode")).toEqual({ ultrathink: false, ultracode: true, any: true });
    expect(ultraKeywords("ultrathink e ultracode")).toEqual({ ultrathink: true, ultracode: true, any: true });
  });

  it("ignora o que a tela também ignora: caminho, flag, arquivo, citação e o NOME do comando", () => {
    for (const notAKeyword of [
      "/ultrathink",
      "/ultracode-review agora",
      "src/ultracode/index.ts",
      "--ultrathink",
      "ultracode.md",
      "a palavra `ultracode`",
      "ultrathinking",
    ]) {
      expect(ultraKeywords(notAKeyword).any).toBe(false);
    }
  });

  /**
   * CÉSAR'S BUG (production, 2026-09-28): a message that opened with
   * `/superpowers:systematic-debugging`, carried paragraphs of context and ended in `ultracode`
   * escalated nothing — the rule discarded the WHOLE message because of its first letter.
   *
   * What is a command is the FIRST TOKEN; what comes after are the arguments, which the command expands
   * into the prompt. This detection is the one that ACTUALLY ESCALATES (the screen's only paints), so it
   * has to agree with `front/src/features/board/lib/ultraWords.ts` letter by letter.
   */
  it("argumento de slash command é prosa: a palavra reservada no fim ainda vale", () => {
    const real = [
      "/superpowers:systematic-debugging preciso que voce confira 2 coisas pra mim.",
      "Confere as mensagens em massa e o disco do KVM1, sem deletar nada... ultracode",
    ].join("\n");
    expect(ultraKeywords(real)).toEqual({ ultrathink: false, ultracode: true, any: true });
    expect(ultraKeywords("/review ultrathink").ultrathink).toBe(true);
  });

  it("escala para o máximo, e cai para o possível quando a sessão não permite", () => {
    expect(source).toContain('{ effortLevel: "max", ultracode: true }');
    expect(source).toContain('{ effortLevel: "max" }');
    expect(source).toContain('{ effortLevel: "xhigh" }');
    expect(source).toContain("applyFlagSettings");
  });

  it("devolve o esforço no fim do turno — a palavra valia para AQUELE turno", () => {
    expect(source).toContain("void inEffortQueue(clearUltra); // the keyword was for THIS turn");
    // The give-back clears ONLY what the driver set: a turn with `ultrathink` must not switch off an
    // `ultracode` the session already had.
    expect(source).toContain("ultraRaised = settings;");
    expect(source).toContain("const give = Object.fromEntries(Object.keys(otherKeys).map((key) => [key, null]));");
    expect(source).toContain("withDeadline(handle.applyFlagSettings(give), EFFORT_STEP_TIMEOUT_MS, EFFORT_STEP_TIMEOUT_ERROR)");
  });

  it("a mensagem NUNCA é engolida por uma escalada que falhou (o push mora no finally)", () => {
    const send = source.slice(source.indexOf("function sendUser(text)"));
    const tryAt = send.indexOf("await inEffortQueue(() => raiseUltra(ultra, true, keyword));");
    const finallyAt = send.indexOf("} finally {");
    const pushAt = send.indexOf("myChannel.push(userMessage(text));", finallyAt);
    expect(tryAt).toBeGreaterThan(0);
    expect(finallyAt).toBeGreaterThan(tryAt);
    expect(pushAt).toBeGreaterThan(finallyAt);
  });

  it("uma corrente recém-criada espera o CLI existir antes de mandar a configuração", () => {
    expect(source).toContain("initializationResult()");
    expect(source).toContain("ULTRA_INIT_TIMEOUT_MS");
  });
});

/**
 * EDIT = REWIND. The edit takes the session back to before the corrected message
 * (`resumeSessionAt`), and then the model never read the wrong version. Measured against the SDK before
 * writing: rewinding to the ASSISTANT uuid of the kept turn brings the old answer back;
 * rewinding to the `result` uuid is refused with `error_during_execution`.
 *
 * What these tests attack is the only way to LOSE data here: rewinding when one cannot.
 * A message that came in mid-turn would be discarded along with it, with no bubble and no log line —
 * and it is a message a PERSON wrote. The decision is a pure function, and it is executed here.
 */
describe("sdk-driver.mjs — editar rebobina, mas só quando é seguro", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** The decision, cut out of the driver and actually executed. */
  const rewindDecision = ((): ((s: unknown, f: unknown, a: unknown, last?: unknown) => { rewind: boolean; reason?: string }) => {
    const from = source.indexOf("function rewindDecision(");
    expect(from).toBeGreaterThan(0);
    const factory = new Function(`${source.slice(from, source.indexOf("\n}", from) + 2)}\nreturn rewindDecision;`);
    return factory() as (s: unknown, f: unknown, a: unknown, last?: unknown) => { rewind: boolean; reason?: string };
  })();

  it("rebobina quando há sessão, ponto de volta e nada foi absorvido", () => {
    expect(rewindDecision("sess", "uuid", false)).toEqual({ rewind: true });
  });

  it("RECUSA quando uma mensagem entrou no meio do turno — ela seria descartada sem rastro", () => {
    expect(rewindDecision("sess", "uuid", true)).toEqual({ rewind: false, reason: "absorbed" });
  });

  it("RECUSA sem ponto de volta: a primeira mensagem de uma sessão não tem pra onde voltar", () => {
    expect(rewindDecision("sess", null, false)).toEqual({ rewind: false, reason: "no-fork-point" });
    expect(rewindDecision(null, "uuid", false)).toEqual({ rewind: false, reason: "no-fork-point" });
    expect(rewindDecision(null, null, false)).toEqual({ rewind: false, reason: "no-fork-point" });
  });

  it("qualquer valor vazio conta como ausente — string vazia não é um uuid", () => {
    // The driver resets these variables with null, but an empty string coming from a crooked frame must
    // not turn into an invalid `resumeSessionAt`: that kills the turn with error_during_execution.
    expect(rewindDecision("", "uuid", false).rewind).toBe(false);
    expect(rewindDecision("sess", "", false).rewind).toBe(false);
    expect(rewindDecision(undefined, undefined, undefined).rewind).toBe(false);
  });

  it("a recusa por absorção só vale quando HÁ como rebobinar — sem ponto de volta a razão é outra", () => {
    // The order of the guards matters for what the screen shows: "absorbed" is a decision, "no-fork-point" is
    // an impossibility, and swapping them would make the panel explain the wrong thing.
    expect(rewindDecision(null, null, true)).toEqual({ rewind: false, reason: "no-fork-point" });
  });

  it("o ponto de volta é o uuid do ASSISTANT — o do result é recusado pelo CLI", () => {
    // Only the MAIN agent's message (`parent === null`): a subagent's lives on a sidechain — the
    // behaviour is covered, with the driver running, in sdk-driver.test.ts ("subagentes").
    expect(source).toContain("if (msg.uuid && parent === null) lastAssistantUuid = msg.uuid;");
    // and it is recorded on the assistant's branch, not on the result's
    const assistantBranch = source.slice(source.indexOf('} else if (msg.type === "assistant")'), source.indexOf('} else if (msg.type === "result")'));
    expect(assistantBranch).toContain("lastAssistantUuid");
    const resultBranch = source.slice(source.indexOf('} else if (msg.type === "result")'));
    expect(resultBranch.slice(0, 400)).not.toContain("lastAssistantUuid");
  });

  it("uma mensagem absorvida ARMA a trava e não move o ponto de volta", () => {
    expect(source).toContain("if (absorbed) absorbedSinceFork = true;");
    // and it keeps WHOSE point it is: the memory only rewinds that message
    expect(source).toContain("else { forkPoint = lastAssistantUuid; forkText = text; absorbedSinceFork = false; }");
  });

  it("o truncamento vale por UM stream só — o seguinte continua da ponta nova", () => {
    const run = source.slice(source.indexOf("async function runStream()"));
    const set = run.indexOf("options.resumeSessionAt = pendingResumeAt;");
    const clear = run.indexOf("pendingResumeAt = null;");
    expect(set).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(set); // consumed right when it is used
    // and never without a session: a resumeSessionAt without resume has nothing to truncate
    expect(run).toContain("if (pendingResumeAt && lastSessionId) {");
  });

  it("a edição NUNCA some: os dois caminhos terminam mandando a mensagem", () => {
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    // refusal -> supersede; failure to knock down the stream -> supersede; success -> clean text;
    // original that never arrived -> clean text, without rewinding
    expect(fn.match(/sendUser\(/g) ?? []).toHaveLength(3);
    expect(fn.match(/\bsupersede\("/g) ?? []).toHaveLength(1); // failure to knock down
    expect(fn).toContain("supersede(decision.reason)"); // recusa
    expect(fn).toContain("} catch {");
    // and plan B falls back to clean text if the manager sent no fallback at all
    expect(fn.match(/typeof fallback === "string" && fallback !== "" \? fallback : text/g) ?? []).toHaveLength(1);
  });

  it("original que o modelo nunca leu: vai o texto LIMPO, sem invólucro e sem derrubar o stream", () => {
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    const branch = fn.slice(fn.indexOf("disk.absent"), fn.indexOf("await endStream()"));
    expect(branch).toContain('emit({ type: "rewound", ok: false, reason: "not-delivered" })');
    expect(branch).toContain("sendUser(text)");
    // the words go in BEFORE releasing the cards, as in the normal send
    expect(branch.indexOf("releaseQuestions()")).toBeGreaterThan(branch.indexOf("sendUser(text)"));
    expect(branch.indexOf("return;")).toBeGreaterThan(branch.indexOf("releaseQuestions()"));
  });

  it("a mensagem vai ANTES de liberar os cartões de pergunta (mesma ordem do envio normal)", () => {
    // The window is the `edit_user` BRANCH, not a number of characters: one more comment in
    // there is not a regression, and that is what this 600-char measure had started calling one.
    const handler = source.slice(source.indexOf('control.type === "edit_user"'), source.indexOf('control.type === "permission_decision"'));
    expect(handler).toContain("rewindAndSend(control.text, control.fallback, control.original, supersedePendingQuestions, control.first === true)");
    // supersede: the words go in BEFORE releasing; rewind: releases before knocking down the turn
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    const sup = fn.slice(fn.indexOf("const supersede = "), fn.indexOf("};", fn.indexOf("const supersede = ")));
    expect(sup.indexOf("releaseQuestions()")).toBeGreaterThan(sup.indexOf("sendUser("));
    expect(fn).toMatch(/releaseQuestions\(\);\s*try \{\s*await endStream\(\)/);
  });

  it("o ponto de volta vem do DISCO, decidido ANTES de derrubar o stream — supersede não reinicia o CLI", () => {
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    const disk = fn.indexOf("forkPointFromTranscript(await readSessionTranscript(");
    const memory = fn.indexOf("rewindDecision(");
    const teardown = fn.indexOf("await endStream()");
    expect(disk).toBeGreaterThan(0);
    expect(memory).toBeGreaterThan(disk); // the memory only decides when the disk did not find it
    expect(teardown).toBeGreaterThan(memory); // and the stream only drops when it IS going to rewind
    expect(fn.match(/await endStream\(\)/g) ?? []).toHaveLength(1);
  });

  it("a memória só vale para a ÚLTIMA mensagem enviada — editar outra pela memória rebobinaria a errada", () => {
    expect(rewindDecision("sess", "uuid", false, false)).toEqual({ rewind: false, reason: "no-fork-point" });
    expect(rewindDecision("sess", "uuid", false, true)).toEqual({ rewind: true });
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    expect(fn).toContain("rewindDecision(lastSessionId, forkPoint, absorbedSinceFork, foldText(original) === foldText(forkText))");
  });

  it("enquanto um rebobinar está no meio, mensagens e outras edições ESPERAM a vez — sem corrida no stream", () => {
    const handler = source.slice(source.indexOf('rl.on("line"'));
    const userBranch = handler.slice(handler.indexOf('control.type === "user"'), handler.indexOf('control.type === "edit_user"'));
    const editBranch = handler.slice(handler.indexOf('control.type === "edit_user"'), handler.indexOf('control.type === "permission_decision"'));
    expect(userBranch).toContain("serialized(");
    expect(editBranch).toContain("serialized(");
  });

  it("derrubar o stream espera o anterior soltar a query — duas correntes na mesma sessão é corrida", () => {
    const fn = source.slice(source.indexOf("async function endStream()"), source.indexOf("async function rewindAndSend("));
    expect(fn).toContain("currentQuery === dying");
    expect(fn).toContain("ch.end()");
    // with a ceiling: a stream that never lets go must not lock the edit forever
    expect(fn).toMatch(/i < \d+ && currentQuery === dying/);
  });
});

/**
 * EDIT = GO BACK IN TIME, for ANY message and after ANY restart. The reported bug:
 * editing a message created a new message below (supersede) instead of erasing what came
 * after — because the point to go back to only existed in the driver's memory, only for the last message, and
 * vanished when the driver was knocked down by idleness or a deploy. The session transcript on disk has
 * the whole chain; the point to go back to for any message comes from there.
 */
describe("sdk-driver.mjs — forkPointFromTranscript acha o ponto de volta no disco", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  type Fork = { found: false; absent?: true } | { found: true; uuid: string | null };
  const forkPointFromTranscript = ((): ((jsonl: string, original: string) => Fork) => {
    const from = source.indexOf("function forkPointFromTranscript(");
    expect(from).toBeGreaterThan(0);
    const factory = new Function(`${source.slice(from, source.indexOf("\n}", from) + 2)}\nreturn forkPointFromTranscript;`);
    return factory() as (jsonl: string, original: string) => Fork;
  })();

  const line = (o: Record<string, unknown>): string => JSON.stringify({ isSidechain: false, sessionId: "s", ...o });
  const user = (uuid: string, parentUuid: string | null, content: unknown): string =>
    line({ type: "user", uuid, parentUuid, message: { role: "user", content } });
  const assistant = (uuid: string, parentUuid: string | null, text = "ok"): string =>
    line({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "text", text }] } });

  const conversa = [
    user("u1", null, "primeira pergunta"),
    assistant("a1", "u1"),
    user("u2", "a1", "segunda pergunta"),
    assistant("a2a", "u2", "pensando"),
    user("t2", "a2a", [{ type: "tool_result", tool_use_id: "x", content: "saida" }]),
    assistant("a2b", "t2", "resposta final"),
    user("u3", "a2b", "terceira pergunta"),
    assistant("a3", "u3"),
  ].join("\n");

  it("a ÚLTIMA mensagem volta para o fim da resposta anterior (o último assistant antes dela)", () => {
    expect(forkPointFromTranscript(conversa, "terceira pergunta")).toEqual({ found: true, uuid: "a2b" });
  });

  it("uma mensagem do MEIO também tem ponto de volta — tudo abaixo dela some", () => {
    expect(forkPointFromTranscript(conversa, "segunda pergunta")).toEqual({ found: true, uuid: "a1" });
  });

  it("a PRIMEIRA mensagem volta para o nada: sessão nova (uuid null)", () => {
    expect(forkPointFromTranscript(conversa, "primeira pergunta")).toEqual({ found: true, uuid: null });
  });

  it("compara sem ligar pra espaços — a mesma dobra da tela", () => {
    expect(forkPointFromTranscript(conversa, "  segunda\n pergunta ")).toEqual({ found: true, uuid: "a1" });
  });

  it("conteúdo em blocos de texto conta como a mensagem", () => {
    const jsonl = [user("u1", null, "oi"), assistant("a1", "u1"), user("u2", "a1", [{ type: "text", text: "em blocos" }]), assistant("a2", "u2")].join("\n");
    expect(forkPointFromTranscript(jsonl, "em blocos")).toEqual({ found: true, uuid: "a1" });
  });

  it("só olha o RAMO VIVO: um rewind anterior deixa um galho morto no arquivo que não pode ser achado", () => {
    // "velha" was edited earlier: the session went back to a1 and continued through "nova". The file keeps both.
    const jsonl = [
      user("u1", null, "oi"),
      assistant("a1", "u1"),
      user("old", "a1", "velha"),
      assistant("aold", "old"),
      user("new", "a1", "nova"),
      assistant("anew", "new"),
    ].join("\n");
    // the model does not have "velha" on the live branch: for it that message does not exist
    expect(forkPointFromTranscript(jsonl, "velha")).toEqual({ found: false, absent: true });
    expect(forkPointFromTranscript(jsonl, "nova")).toEqual({ found: true, uuid: "a1" });
  });

  it("a mesma frase dita duas vezes: vale a MAIS RECENTE", () => {
    const jsonl = [user("u1", null, "de novo"), assistant("a1", "u1"), user("u2", "a1", "de novo"), assistant("a2", "u2")].join("\n");
    expect(forkPointFromTranscript(jsonl, "de novo")).toEqual({ found: true, uuid: "a1" });
  });

  it("ignora sidechains (subagentes) e linhas tortas", () => {
    const jsonl = [
      user("u1", null, "oi"),
      assistant("a1", "u1"),
      "{ isto não é json",
      line({ type: "assistant", uuid: "side", parentUuid: "a1", isSidechain: true, message: { content: [] } }),
      user("u2", "a1", "alvo"),
      assistant("a2", "u2"),
    ].join("\n");
    expect(forkPointFromTranscript(jsonl, "alvo")).toEqual({ found: true, uuid: "a1" });
  });

  it("NUNCA confunde o início de uma compactação com o início da conversa — sessão nova perderia tudo", () => {
    const jsonl = [
      line({ type: "system", subtype: "compact_boundary", uuid: "cb", parentUuid: null, logicalParentUuid: "x" }),
      user("sum", "cb", "resumo da conversa anterior"),
      user("u1", "sum", "logo depois do resumo"),
      assistant("a1", "u1"),
    ].join("\n");
    expect(forkPointFromTranscript(jsonl, "logo depois do resumo")).toEqual({ found: false });
  });

  it("uma mensagem ABSORVIDA mais nova com o mesmo texto é a que foi editada — e o disco não a vê como prompt: não achou", () => {
    // "continua" was a turn (u2) and then came in again in the middle of another turn (queued_command).
    // The screen edits the NEWEST one; matching u2 would rewind turns the screen is going to keep.
    const jsonl = [
      user("u1", null, "oi"),
      assistant("a1", "u1"),
      user("u2", "a1", "continua"),
      assistant("a2", "u2"),
      user("u3", "a2", "outra coisa"),
      line({ type: "attachment", uuid: "q1", parentUuid: "u3", attachment: { type: "queued_command", prompt: "continua" } }),
      assistant("a3", "q1"),
    ].join("\n");
    expect(forkPointFromTranscript(jsonl, "continua")).toEqual({ found: false });
  });

  it("uma absorvida com OUTRO texto abaixo da editada some junto — está abaixo dela na tela também", () => {
    const jsonl = [
      user("u1", null, "oi"),
      assistant("a1", "u1"),
      user("u2", "a1", "alvo"),
      line({ type: "attachment", uuid: "q1", parentUuid: "u2", attachment: { type: "queued_command", prompt: "veio junto" } }),
      assistant("a2", "q1"),
    ].join("\n");
    expect(forkPointFromTranscript(jsonl, "alvo")).toEqual({ found: true, uuid: "a1" });
  });

  it("um pai que não está no arquivo (cadeia cortada) também não é o começo da conversa", () => {
    const jsonl = [user("u1", "sumiu", "orfã"), assistant("a1", "u1")].join("\n");
    expect(forkPointFromTranscript(jsonl, "orfã")).toEqual({ found: false });
  });

  it("transcript vazio ou texto vazio: não achou, e NÃO afirma que a mensagem não chegou", () => {
    expect(forkPointFromTranscript("", "oi")).toEqual({ found: false });
    expect(forkPointFromTranscript(conversa, "   ")).toEqual({ found: false });
  });

  /**
   * THE MESSAGE THAT NEVER ARRIVED (production, 2026-10-19): the turn died before the CLI wrote it
   * ("No conversation found with session ID", after switching the card's account). The person edits, and
   * the model received "[correção do usuário — desconsidere a mensagem anterior: «…»]" talking about a
   * message it never read. Only when the live branch was read WHOLE up to the root can one claim
   * that it is not there — compaction and a cut chain remain "don't know" (tests above).
   */
  it("o ramo vivo lido até a raiz sem a mensagem: ela nunca chegou ao modelo (absent)", () => {
    expect(forkPointFromTranscript(conversa, "nunca dita")).toEqual({ found: false, absent: true });
  });

});

/**
 * THE EDIT DOES NOT LEAVE A RED ERROR BEHIND.
 *
 * Editing a message in the middle of a turn ends in two red balloons that should not
 * exist, and both come from the same place: the CLI ends an INTERRUPTED turn as
 * `error_during_execution` carrying only an internal diagnostic
 * (`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`), and the Agent SDK,
 * when the stream closes after that, replaces the exit error with
 * `Error("Claude Code returned an error result: " + errors.join("; "))`. The rewind CLOSES the
 * stream on purpose — so it was causing the banner itself (production, 2026-10-01).
 *
 * The CLI itself shows none of this to anyone: it filters `[ede_diagnostic]` out of its output and only
 * displays an `error_during_execution` when the end was NOT an abort. These tests run the two
 * pure functions that put the driver on the same yardstick.
 */
describe("sdk-driver.mjs — um turno interrompido não é um turno que falhou", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** Cuts a pure function out of the driver and actually executes it (like `rewindDecision` above). */
  function cut<T>(name: string): T {
    const from = source.indexOf(`function ${name}(`);
    expect(from).toBeGreaterThan(0);
    const body = source.slice(from, source.indexOf("\n}", from) + 2);
    const deps = source.slice(source.indexOf("const INTERNAL_DIAGNOSTICS = ["), source.indexOf("\n", source.indexOf("const INTERNAL_DIAGNOSTICS = [")));
    return new Function(`${deps}\n${body}\nreturn ${name};`)() as T;
  }

  const humanErrorText = cut<(m: unknown) => string>("humanErrorText");
  const wasAborted = cut<(r: unknown) => boolean>("wasAborted");

  it("engole o erro do SDK quando ele é só o diagnóstico interno do CLI", () => {
    const sdkError = "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";
    expect(humanErrorText(sdkError)).toBe("");
  });

  it("engole o diagnóstico cru, sem o prefixo do SDK", () => {
    expect(humanErrorText("[ede_diagnostic] result_type=assistant stop_reason=end_turn")).toBe("");
  });

  it("um CRASH não é engolido: jargão que a pessoa pode agir em cima vale mais que silêncio", () => {
    // The CLI hides `[session_crash]` from its own UI, but there it has other ways of telling. Here,
    // swallowing it would mean a turn that stops with no answer, no error and no explanation at all.
    expect(humanErrorText("[session_crash] worker died")).toBe("[session_crash] worker died");
    expect(humanErrorText("Claude Code returned an error result: [session_crash] worker died"))
      .toBe("Claude Code returned an error result: [session_crash] worker died");
  });

  it("um diagnóstico com ponto e vírgula dentro não vaza o rabo como se fosse erro", () => {
    // The cut is at the SDK's separator ("; "), not at any ";": otherwise half a diagnostic
    // would become a red sentence on its own in the conversation.
    expect(humanErrorText("Claude Code returned an error result: [ede_diagnostic] a;b stop_reason=x")).toBe("");
  });

  it("mas PRESERVA o que é erro de verdade quando os dois vêm juntos", () => {
    const mixed = "Claude Code returned an error result: [ede_diagnostic] result_type=user; prompt is too long";
    expect(humanErrorText(mixed)).toBe("Claude Code returned an error result: prompt is too long");
  });

  it("um erro comum passa inteiro — inclusive com ponto e vírgula no meio", () => {
    expect(humanErrorText("spawn ENOENT; the driver is not installed")).toBe("spawn ENOENT; the driver is not installed");
    expect(humanErrorText("driver exited (code 1)")).toBe("driver exited (code 1)");
  });

  it("é total: nada, vazio ou lixo não viram um banner", () => {
    expect(humanErrorText(undefined)).toBe("");
    expect(humanErrorText(null)).toBe("");
    expect(humanErrorText("   ")).toBe("");
    expect(humanErrorText("Claude Code returned an error result:   ")).toBe("");
  });

  it("abort é a palavra do CLI pra interrupção — e interrupção não é falha", () => {
    expect(wasAborted("aborted_streaming")).toBe(true);
    expect(wasAborted("aborted_tools")).toBe(true);
  });

  it("qualquer outro fim continua sendo erro — a filtragem não pode virar um silenciador", () => {
    expect(wasAborted("api_error")).toBe(false);
    expect(wasAborted("prompt_too_long")).toBe(false);
    expect(wasAborted("completed")).toBe(false);
    expect(wasAborted(undefined)).toBe(false);
    expect(wasAborted(null)).toBe(false);
  });

  it("o `isError` do result é desarmado pelo abort, não pelo subtype", () => {
    const at = source.indexOf('} else if (msg.type === "result")');
    const branch = source.slice(at, at + 900);
    expect(branch).toContain("const aborted = wasAborted(msg.terminal_reason);");
    expect(branch).toContain("isError: !!msg.is_error && !aborted");
  });

  it("uma corrente que nem CHEGOU a nascer continua virando erro — null não é 'fechada de propósito'", () => {
    // `query()` blows up SYNCHRONOUSLY (invalid option, missing binary) and at that moment `myQuery` is still
    // null — the same value as `closingQuery` at rest. Without the guard, the startup error would be read
    // as our own teardown: no `error`, no `result` (the `finally` does not close a turn that had not
    // been marked yet) and the message vanishing with the spinner stuck.
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("let myQuery = null;");
    expect(run).toContain("if (myQuery !== null && closingQuery === myQuery) trace(");
    // and `myQuery` only exists AFTER `query()` has returned without blowing up
    const assign = run.indexOf("currentQuery = query({ prompt: myChannel, options });");
    expect(run.indexOf("myQuery = currentQuery;")).toBeGreaterThan(assign);
  });

  it("a corrente derrubada pelo rebobinar não vira erro na tela", () => {
    const teardown = source.slice(source.indexOf("async function endStream()"), source.indexOf("async function rewindAndSend("));
    expect(teardown).toContain("closingQuery = dying;");
    // claimed BEFORE the first step that can kill it
    expect(teardown.indexOf("closingQuery = dying;")).toBeLessThan(teardown.indexOf("dying.interrupt()"));

    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("closingQuery === myQuery) trace(");
    // and the claim does not leak into the next stream
    expect(run).toContain("if (closingQuery === myQuery) closingQuery = null;");
  });

  it("só o stream VIGENTE encerra turno e larga o handle — o que sobreviveu ao teardown não manda", () => {
    // When `endStream` gives up waiting, the old stream stays alive next to the new one. Without the
    // identity guard, its `finally` closed the NEW turn and zeroed the LIVE `currentQuery` —
    // and with it the stop button, which becomes a no-op without telling anyone.
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("const stillOurs = currentQuery === myQuery;");
    expect(run).toContain("if (stillOurs) closeTurnAborted();");
    expect(run).toMatch(/if \(stillOurs\) \{\s*currentQuery = null;/);
    // and the loop BODY too: what a disinherited stream says is only drained (see sdk-driver.test.ts)
    expect(run).toContain("if (currentQuery !== myQuery) continue;");
  });

  it("o que é engolido ainda é registrado — no stderr, nunca no stdout do protocolo", () => {
    expect(source).toContain("process.stderr.write(`[sdk-driver] ${line}\\n`)");
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("trace(`stream error with nothing to tell:");
  });
});

/**
 * THE CONVERSATION THAT MOVED OUTSIDE THE CHAT (production, 2026-10-05). César edited a message and
 * nothing rewound: it had come from the Terminal tab, which talks to the SAME session through ANOTHER
 * CLI process. The chat's open stream holds the conversation in memory, so the chat's next message
 * continued from an EARLIER point and left the terminal's turn on a dead branch — and a dead branch
 * has no way back (`forkPointFromTranscript` only walks the live branch, on purpose), so the edit
 * fell into the supersede.
 *
 * The fix is not to loosen the fork point: it is to keep the dead branch from being born. The back
 * warns (`reanchor`), the driver MARKS it, and the next send reopens the stream at the real end of the file.
 */
describe("sdk-driver.mjs — religar no fim real quando a conversa anda fora do chat", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  it("o controle `reanchor` só MARCA — derrubar a corrente a cada linha do terminal custaria um CLI por linha", () => {
    const at = source.indexOf('control.type === "reanchor"');
    expect(at).toBeGreaterThan(0);
    const branch = source.slice(at, at + 260);
    expect(branch).toContain("staleView = true;");
    expect(branch).not.toContain("endStream(");
  });

  it("a marca é paga ANTES de a mensagem entrar na corrente — depois já seria o galho irmão", () => {
    const handler = source.slice(source.indexOf('rl.on("line"'));
    const userBranch = handler.slice(handler.indexOf('control.type === "user"'), handler.indexOf('control.type === "edit_user"'));
    expect(userBranch).toContain("await reanchorIfStale();");
    expect(userBranch.indexOf("await reanchorIfStale();")).toBeLessThan(userBranch.indexOf("sendUser("));
  });

  it("a edição também religa antes de decidir: um supersede na corrente velha órfã o terminal de novo", () => {
    const handler = source.slice(source.indexOf('rl.on("line"'));
    const editBranch = handler.slice(handler.indexOf('control.type === "edit_user"'), handler.indexOf('control.type === "permission_decision"'));
    expect(editBranch).toContain("await reanchorIfStale();");
    expect(editBranch.indexOf("await reanchorIfStale();")).toBeLessThan(editBranch.indexOf("rewindAndSend("));
  });

  it("religar NÃO fixa ponto de retomada: sem pendingResumeAt o CLI retoma do fim do arquivo", () => {
    const fn = source.slice(source.indexOf("async function reanchorIfStale()"), source.indexOf("async function rewindAndSend("));
    expect(fn).toContain("await endStream();");
    expect(fn).not.toContain("pendingResumeAt");
  });

  it("um turno NOSSO em voo manda mais que a marca — derrubá-lo perderia a resposta sendo escrita", () => {
    const fn = source.slice(source.indexOf("async function reanchorIfStale()"), source.indexOf("async function rewindAndSend("));
    expect(fn).toContain("if (!staleView || turnActive) return;");
  });

  it("teardown que falha MANTÉM a marca — religar na próxima é melhor que achar que já religou", () => {
    const fn = source.slice(source.indexOf("async function reanchorIfStale()"), source.indexOf("async function rewindAndSend("));
    const catchAt = fn.indexOf("} catch {");
    expect(catchAt).toBeGreaterThan(0);
    // the catch's `return` comes BEFORE the mark is lowered
    expect(fn.indexOf("return;", catchAt)).toBeLessThan(fn.indexOf("staleView = false;", catchAt));
  });

  it("o ponto de volta em memória morre junto: ele aponta para uma linha do tempo vencida", () => {
    const fn = source.slice(source.indexOf("async function reanchorIfStale()"), source.indexOf("async function rewindAndSend("));
    expect(fn).toContain("forkPoint = null;");
    expect(fn).toContain("forkText = null;");
    expect(fn).toContain("absorbedSinceFork = false;");
  });

  it("sem corrente aberta a marca cai sem custo — o próximo stream já nasce do fim do arquivo", () => {
    const fn = source.slice(source.indexOf("async function reanchorIfStale()"), source.indexOf("async function rewindAndSend("));
    expect(fn).toContain("if (!currentQuery) { staleView = false; return; }");
  });
});

/**
 * THE OPUS PROMPT DOES NOT TALK ABOUT THE REASONING. The instruction "escreva seu raciocínio em português"
 * (7bf6ace, softened in 4403c05) was the known trigger of Opus's `[reasoning_extraction]` block —
 * and it did not even work properly: with `display: "summarized"` the text that arrives is a SUMMARY,
 * which sometimes followed the instruction and sometimes came back in English. The translation now
 * happens in the BROWSER, only on display (front/src/features/board/lib/reasoningTranslation.ts); the
 * model never knows.
 */
describe("sdk-driver.mjs — o prompt não mexe no raciocínio", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  const opts = source.slice(source.indexOf("function baseOptions()"), source.indexOf("/* ------------------------------------------- the command catalogue"));

  it("o system prompt é o preset do Claude Code PURO — sem `append`, em nenhum idioma", () => {
    expect(opts).toContain('systemPrompt: { type: "preset", preset: "claude_code" },');
    expect(opts).not.toContain("append");
  });

  it("nenhuma instrução sobre o raciocínio sobrou no driver", () => {
    expect(source).not.toContain("function reasoningInstruction(");
    expect(source).not.toContain("reasoningLanguage");
    expect(source).not.toMatch(/Escreva seu racioc/i);
  });

  it("o driver não tem mais um controle de idioma — o protocolo nem o entrega", () => {
    expect(source).not.toContain('control.type === "language"');
  });
});

/**
 * OPUS BLOCKED EVERY CHAT MESSAGE (card #3684, 2026-10-06). Anthropic's raw error —
 * `safeguards flagged this message ... [reasoning_extraction]` — is a DOCUMENTED false positive of
 * Opus's safety classifier (claude-code#93584, #89503, #95275, among dozens of other public
 * issues): the SERVER flags a benign conversation, not its content. There is no way for the
 * driver to avoid the block itself (it is born on Anthropic's side, before the response arrives), but
 * two things were within the code's reach:
 *
 *   1. the reasoning-language instruction mentioned "os blocos de thinking" — technical vocabulary
 *      that #93584 itself shows as a known trigger. Softened here and, later, REMOVED for good
 *      (the reasoning started being translated in the browser — see the describe "o prompt não mexe
 *      no raciocínio", above).
 *   2. the message that reached the human carried only the raw English text, without explaining that
 *      it is a known classifier bug and not something about the question asked.
 */
describe("sdk-driver.mjs — o Opus bloqueava toda mensagem (card #3684)", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  function cut<T>(name: string): T {
    const from = source.indexOf(`function ${name}(`);
    expect(from).toBeGreaterThan(0);
    const body = source.slice(from, source.indexOf("\n}", from) + 2);
    return new Function(`${body}\nreturn ${name};`)() as T;
  }
  const humanizeSafeguardError = cut<(t: string) => string>("humanizeSafeguardError");

  it("reconhece o texto exato do bloqueio (produção, req_011CfmXhGyLQqn57VzrtHonU)", () => {
    const raw =
      "API Error: Opus 5 (1M context)'s safeguards flagged this message " +
      "(https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal " +
      "conversations. Claude Code can't respond to this message with Opus 5 (1M context).\n\n" +
      "Try rephrasing the request in a new session or change your model.\n\n" +
      "Details: `[reasoning_extraction]`\n\nRequest ID: req_011CfmXhGyLQqn57VzrtHonU";
    const out = humanizeSafeguardError(raw);
    expect(out).toContain("falso positivo conhecido");
    expect(out).toContain("sem relação com o conteúdo desta conversa");
  });

  it("ANEXA a explicação — não apaga o texto original, o Request ID nele é o que vale pra abrir chamado", () => {
    const raw = "safeguards flagged this message. Details: `[reasoning_extraction]` Request ID: req_abc";
    const out = humanizeSafeguardError(raw);
    expect(out.startsWith(raw)).toBe(true);
    expect(out.length).toBeGreaterThan(raw.length);
  });

  it("reconhece pela categoria do erro mesmo sem a frase 'safeguards flagged'", () => {
    expect(humanizeSafeguardError("Details: `[reasoning_extraction]`")).toContain("falso positivo conhecido");
  });

  it("um erro comum, sem relação com o classificador, passa intacto", () => {
    expect(humanizeSafeguardError("spawn ENOENT; the driver is not installed"))
      .toBe("spawn ENOENT; the driver is not installed");
    expect(humanizeSafeguardError("prompt is too long")).toBe("prompt is too long");
  });

  it("o catch de runStream passa o texto humano pelo tradutor antes de emitir — não substitui, encadeia", () => {
    const run = source.slice(source.indexOf("async function runStream()"), source.indexOf("async function endStream()"));
    expect(run).toContain('emit({ type: "error", message: missingCwdError(humanizeSafeguardError(detail)) });');
  });
});

/**
 * THE AI "CHOKING" ON THE LARGE WRITE. While the model generated the input of a Write/Edit (tens of
 * seconds for a 400-line file), the driver discarded the tool_use's `content_block_start` and
 * all the `input_json_delta`s: the screen sat on "Trabalhando…" until the whole input arrived. The
 * tracker turns that stream into two ephemeral signals — the tool STARTED, and how much of the
 * input is already out (with the file, as soon as it shows up in the partial JSON) — with the clock injected,
 * so the throttle is proven without depending on the machine's time.
 */
describe("sdk-driver.mjs — o input de uma ferramenta sendo gerado", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  type TrackerEvent = { type: string } & Record<string, unknown>;
  interface Tracker { see(ev: unknown, now: number): TrackerEvent[]; done(id: string): void }

  function cut<T>(name: string): T {
    const from = source.indexOf(`function ${name}(`);
    expect(from).toBeGreaterThan(0);
    const body = source.slice(from, source.indexOf("\n}", from) + 2);
    return new Function(`${body}\nreturn ${name};`)() as T;
  }
  const createToolInputTracker = cut<(throttleMs: number) => Tracker>("createToolInputTracker");

  const start = (index: number, id: string, name: string) =>
    ({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
  const delta = (index: number, partial: string) =>
    ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });

  it("anuncia o começo do tool_use com id e nome, na hora", () => {
    const tracker = createToolInputTracker(500);
    expect(tracker.see(start(1, "toolu_1", "Write"), 0)).toEqual([{ type: "tool_use_start", id: "toolu_1", name: "Write" }]);
  });

  it("conta os bytes do input por bloco (o delta traz só o índice) e acha o arquivo no JSON parcial", () => {
    const tracker = createToolInputTracker(500);
    tracker.see(start(1, "toolu_1", "Write"), 0);
    expect(tracker.see(delta(1, '{"file_'), 0)).toEqual([{ type: "tool_input_progress", id: "toolu_1", bytes: 7 }]);
    // The path closes in this chunk: it goes out right away, even inside the throttle window — it is what
    // becomes "Escrevendo sdkChat.ts…". The "é" at the end counts 2 bytes: it is size in UTF-8, not in characters.
    expect(tracker.see(delta(1, 'path": "/w/src/sdkChat.ts", "content": "é'), 10)).toEqual([
      { type: "tool_input_progress", id: "toolu_1", bytes: 7 + 42, filePath: "/w/src/sdkChat.ts" },
    ]);
  });

  it("throttle: no máximo um progresso por janela, por bloco", () => {
    const tracker = createToolInputTracker(500);
    tracker.see(start(0, "toolu_1", "Write"), 0);
    const out: TrackerEvent[] = [];
    for (let now = 0; now < 1200; now += 50) out.push(...tracker.see(delta(0, "xx"), now));
    // 0, 500 and 1000: three windows, three progress events — the other 21 deltas only count bytes.
    expect(out.map((e) => e.bytes)).toEqual([2, 22, 42]);
  });

  it("cada bloco tem o seu throttle e o seu id; um índice desconhecido não vira progresso de ninguém", () => {
    const tracker = createToolInputTracker(500);
    tracker.see(start(1, "toolu_a", "Edit"), 0);
    tracker.see(start(2, "toolu_b", "Bash"), 0);
    expect(tracker.see(delta(1, "{}"), 0)).toEqual([{ type: "tool_input_progress", id: "toolu_a", bytes: 2 }]);
    expect(tracker.see(delta(2, "{}"), 0)).toEqual([{ type: "tool_input_progress", id: "toolu_b", bytes: 2 }]);
    expect(tracker.see(delta(7, "{}"), 0)).toEqual([]);
  });

  it("nunca depois do tool_use completo: `done` esquece o bloco", () => {
    const tracker = createToolInputTracker(500);
    tracker.see(start(1, "toolu_1", "Write"), 0);
    tracker.see(delta(1, "{"), 0);
    tracker.done("toolu_1");
    expect(tracker.see(delta(1, "}"), 10_000)).toEqual([]);
  });

  it("um índice reaproveitado na mensagem seguinte não cai no id da anterior", () => {
    const tracker = createToolInputTracker(500);
    tracker.see(start(1, "toolu_old", "Write"), 0);
    tracker.see({ type: "content_block_stop", index: 1 }, 0);
    expect(tracker.see(delta(1, "{}"), 10_000)).toEqual([]);
    tracker.see(start(1, "toolu_x", "Write"), 0);
    tracker.see({ type: "message_start", message: {} }, 0);
    expect(tracker.see(delta(1, "{}"), 10_000)).toEqual([]);
  });

  it("texto, raciocínio e blocos que não são tool_use passam sem gerar nada", () => {
    const tracker = createToolInputTracker(500);
    expect(tracker.see({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, 0)).toEqual([]);
    expect(tracker.see({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "oi" } }, 0)).toEqual([]);
    expect(tracker.see(undefined, 0)).toEqual([]);
  });
});

/**
 * RESUMING A SESSION THAT NO LONGER EXISTS. Claude Code deletes on its own the transcripts idle for
 * weeks (`cleanupPeriodDays`); the card keeps the `resumeSessionId` forever. The `--resume` of an
 * id with no file died with "No conversation found with session ID" on EVERY turn — the card became
 * unusable (production, 2026-11-10: card idle since 19/10, session 56c2c01d). The driver checks the
 * file before resuming; only a PROVEN "it is not there" drops the resume.
 */
describe("sdk-driver.mjs — sessão cujo transcript sumiu", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  const from = source.indexOf("function sessionTranscriptExists(");
  const body = source.slice(from, source.indexOf("\n}", from) + 2);
  const re = source.slice(source.indexOf("const SESSION_FILE_ID_RE ="), source.indexOf("\n", source.indexOf("const SESSION_FILE_ID_RE =")));
  const exists = new Function("readdirSync", "existsSync", "join", `${re}\n${body}\nreturn sessionTranscriptExists;`)(
    fs.readdirSync, fs.existsSync, path.join,
  ) as (root: string, id: string) => boolean;

  const ID = "56c2c01d-e142-4150-9618-c76ebbaa6bd4";
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-resume-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("acha o transcript em qualquer pasta de projeto", () => {
    fs.mkdirSync(path.join(root, "-work-a"));
    fs.mkdirSync(path.join(root, "-work-b"));
    fs.writeFileSync(path.join(root, "-work-b", `${ID}.jsonl`), "{}\n");
    expect(exists(root, ID)).toBe(true);
  });

  it("o caso de produção: pastas listadas, nenhuma tem o arquivo → não existe", () => {
    fs.mkdirSync(path.join(root, "-work-a"));
    expect(exists(root, ID)).toBe(false);
  });

  it("sem pasta de projeto nenhuma também é 'não existe' (a limpeza levou tudo)", () => {
    expect(exists(root, ID)).toBe(false);
  });

  it("raiz ilegível NÃO é prova de ausência: mantém o resume como antes", () => {
    expect(exists(path.join(root, "nao-existe"), ID)).toBe(true);
  });

  it("id que não é UUID nunca vira caminho, e não derruba nada", () => {
    expect(exists(root, "../../etc/passwd")).toBe(true);
  });
});

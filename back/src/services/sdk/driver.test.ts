import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildSdkDriverCommandLine,
  buildInstallDriverScript,
  buildEnsureSdkScript,
  SDK_DRIVER_PATH,
  SDK_DRIVER_DIR,
  SDK_PACKAGE_VERSION,
  SDK_VERSION_MARKER,
} from "./driver.js";

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
      model: "claude-opus-5",
    });
    expect(line).toContain("--resume");
    expect(line).toContain("0d1b3864-4870-4141-8451-79d73de0bd96");
    expect(line).toContain("--model");
    expect(line).toContain("claude-opus-5");
  });

  it("drops an invalid model rather than passing raw input to the shell", () => {
    const line = buildSdkDriverCommandLine({ ...base, model: "; rm -rf / #" });
    expect(line).not.toContain("--model");
    expect(line).not.toContain("rm -rf");
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
      cardId: "card-1",
      statusUrl: "https://hub.example.com/api/runner/status",
    });
    expect(line).toContain("PW_CDP_ENDPOINT=");
    expect(line).toContain("http://127.0.0.1:39222");
    expect(line).toContain("VIBEHUB_CARD_ID=");
    expect(line).toContain("card-1");
    expect(line).toContain("VIBEHUB_STATUS_URL=");
    expect(line).toContain("https://hub.example.com/api/runner/status");
    // Without them, nothing is exported — a driver spawned by an older path stays valid.
    const bare = buildSdkDriverCommandLine(base);
    expect(bare).not.toContain("PW_CDP_ENDPOINT");
    expect(bare).not.toContain("VIBEHUB_CARD_ID");
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
    expect(script).toContain(`chmod 755 '${SDK_DRIVER_PATH}.tmp'`);
    expect(script).toContain(`mv -f '${SDK_DRIVER_PATH}.tmp' '${SDK_DRIVER_PATH}'`);
    expect(script).toContain("console.log('hi')");
    // quoted heredoc delimiter => the source is written literally, not expanded
    expect(script).toContain("<<'VIBEHUB_SDK_DRIVER_SRC'");
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
 * O DRIVER NÃO É IMPORTÁVEL (é um .mjs que roda dentro do runner, onde o SDK está instalado), então
 * o que dá para cercar aqui é o SEU TEXTO. Não é preciosismo: este trecho tem duas armadilhas que
 * não fazem barulho nenhum quando quebram.
 *
 * 1. `display: "summarized"` — nos modelos atuais o padrão é `omitted`, e aí os blocos de thinking
 *    chegam VAZIOS. Sem essa linha o driver segue "funcionando", emitindo nada, e a tela volta a
 *    mostrar só o spinner: um sumiço silencioso, do tipo que só aparece em produção.
 * 2. O delta carrega o texto em `delta.thinking`, NÃO em `delta.text` (ThinkingDelta da Messages
 *    API). Copiar a linha do texto e trocar o tipo devolve `undefined` a cada token.
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
 * A MENSAGEM QUE DESTRAVA O CARTÃO (produção, 2026-09-17): com um plano de opções na tela, escrever
 * no chat não fazia nada — o turno estava parado dentro do `canUseTool` e a mensagem ficava na fila
 * do CLI até o timeout de 30 minutos. O `.mjs` não é importável, então o que se cerca é o texto: as
 * duas armadilhas aqui são a ORDEM (liberar antes de empurrar deixa o turno seguir sem ler a
 * mensagem — o oposto do que a pessoa pediu) e a mensagem que o modelo lê no lugar da escolha.
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
 * AS DUAS PALAVRAS RESERVADAS. `ultrathink` e `ultracode` não são texto: o CLI lê as duas do que
 * você escreve e age — a primeira pede raciocínio mais fundo no turno, a segunda opta o turno pela
 * orquestração multi-agente. O que o CLI NÃO faz é subir o NÍVEL de esforço, e é isso que o painel
 * promete quando pinta a palavra no compositor; o driver é quem cumpre.
 *
 * O `.mjs` não é importável, então a detecção — que precisa bater EXATAMENTE com
 * `front/src/features/board/lib/ultraWords.ts`, senão a tela pinta uma palavra que o back ignora —
 * é recortada do fonte e executada aqui. O resto são invariantes de fiação, incluindo a única que
 * pode custar caro: a mensagem tem de ser empurrada mesmo quando a escalada falha.
 */
describe("sdk-driver.mjs — ultrathink / ultracode", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** A detecção, recortada do driver e executada de verdade. */
  const ultraKeywords = ((): ((text: string) => { ultrathink: boolean; ultracode: boolean; any: boolean }) => {
    const from = source.indexOf("const ULTRA_CLOSERS");
    const to = source.indexOf("/** Our escalation is currently");
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

  it("ignora o que a tela também ignora: comando, caminho, flag, arquivo e citação", () => {
    for (const notAKeyword of [
      "/review ultrathink",
      "src/ultracode/index.ts",
      "--ultrathink",
      "ultracode.md",
      "a palavra `ultracode`",
      "ultrathinking",
    ]) {
      expect(ultraKeywords(notAKeyword).any).toBe(false);
    }
  });

  it("escala para o máximo, e cai para o possível quando a sessão não permite", () => {
    expect(source).toContain('{ effortLevel: "max", ultracode: true }');
    expect(source).toContain('{ effortLevel: "max" }');
    expect(source).toContain('{ effortLevel: "xhigh" }');
    expect(source).toContain("applyFlagSettings");
  });

  it("devolve o esforço no fim do turno — a palavra valia para AQUELE turno", () => {
    expect(source).toContain("void clearUltra(); // the keyword was for THIS turn");
    expect(source).toContain("applyFlagSettings({ effortLevel: null, ultracode: null })");
  });

  it("a mensagem NUNCA é engolida por uma escalada que falhou (o push mora no finally)", () => {
    const send = source.slice(source.indexOf("function sendUser(text)"));
    const tryAt = send.indexOf("await raiseUltra(ultra, true);");
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

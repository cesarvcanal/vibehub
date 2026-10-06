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
 * O MENU "/" DE UM CARD NOVO (produção, 26/09/2026): abrir um card, digitar "/code-re" e não ser
 * oferecido nada. O catálogo vinha só do `init`, que só acontece quando um turno começa — então o
 * card recém-aberto, que é exatamente onde se quer escolher um comando, ficava sem menu.
 *
 * O `.mjs` não é importável, então o que se cerca é o texto — e aqui há três armadilhas mudas:
 * perguntar o catálogo sem encerrar a consulta descartável deixaria um CLI vivo por card; deixar
 * `VIBEHUB_STATUS_URL` passar faria o hook de SessionStart mandar status de um card sem turno
 * nenhum; e marcar `catalogAnnounced` aqui congelaria o catálogo provisório (sem skill/plugin) no
 * lugar do completo que o primeiro `init` traz.
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

  it("não marca o catálogo como anunciado: o `init` de verdade ainda substitui este", () => {
    expect(source).toContain("if (catalogAnnounced || channel || warmChannel) return;");
    expect(source).not.toMatch(/warmCatalog[\s\S]{0,800}catalogAnnounced = true/);
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
   * O BUG DO CÉSAR (produção, 2026-09-28): uma mensagem que abria com
   * `/superpowers:systematic-debugging`, trazia parágrafos de contexto e terminava em `ultracode`
   * não escalava nada — a regra descartava a mensagem INTEIRA por causa da primeira letra.
   *
   * O que é comando é o PRIMEIRO TOKEN; o que vem depois são os argumentos, que o comando expande
   * para dentro do prompt. Esta detecção é a que ESCALA de verdade (a da tela só pinta), então ela
   * tem de concordar com `front/src/features/board/lib/ultraWords.ts` letra por letra.
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
    expect(source).toContain("void clearUltra(); // the keyword was for THIS turn");
    // A devolução limpa SÓ o que o driver fixou: um turno com `ultrathink` não pode desligar um
    // `ultracode` que a sessão já tinha.
    expect(source).toContain("ultraRaised = settings;");
    expect(source).toContain("for (const key of Object.keys(raised)) give[key] = null;");
    expect(source).toContain("await handle.applyFlagSettings(give);");
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

/**
 * EDITAR = REBOBINAR. A edição leva a sessão de volta pra antes da mensagem corrigida
 * (`resumeSessionAt`), e aí o modelo nunca leu a versão errada. Medido contra o SDK antes de
 * escrever: rebobinar no uuid do ASSISTANT do turno mantido traz a resposta antiga de volta;
 * rebobinar no uuid do `result` é recusado com `error_during_execution`.
 *
 * O que estes testes atacam é a única forma de PERDER dado aqui: rebobinar quando não se pode.
 * Uma mensagem que entrou no meio do turno seria descartada junto, sem bolha e sem linha no log —
 * e é uma mensagem que uma PESSOA escreveu. A decisão é uma função pura, e ela é executada aqui.
 */
describe("sdk-driver.mjs — editar rebobina, mas só quando é seguro", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** A decisão, recortada do driver e executada de verdade. */
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
    // O driver zera essas variáveis com null, mas uma string vazia vinda de um frame torto não
    // pode virar um `resumeSessionAt` inválido: isso mata o turno com error_during_execution.
    expect(rewindDecision("", "uuid", false).rewind).toBe(false);
    expect(rewindDecision("sess", "", false).rewind).toBe(false);
    expect(rewindDecision(undefined, undefined, undefined).rewind).toBe(false);
  });

  it("a recusa por absorção só vale quando HÁ como rebobinar — sem ponto de volta a razão é outra", () => {
    // Ordem das travas importa pro que a tela mostra: "absorbed" é uma decisão, "no-fork-point" é
    // uma impossibilidade, e trocá-las faria o painel explicar a coisa errada.
    expect(rewindDecision(null, null, true)).toEqual({ rewind: false, reason: "no-fork-point" });
  });

  it("o ponto de volta é o uuid do ASSISTANT — o do result é recusado pelo CLI", () => {
    expect(source).toContain("if (msg.uuid) lastAssistantUuid = msg.uuid;");
    // e ele é gravado no ramo do assistant, não no do result
    const assistantBranch = source.slice(source.indexOf('} else if (msg.type === "assistant")'), source.indexOf('} else if (msg.type === "result")'));
    expect(assistantBranch).toContain("lastAssistantUuid");
    const resultBranch = source.slice(source.indexOf('} else if (msg.type === "result")'));
    expect(resultBranch.slice(0, 400)).not.toContain("lastAssistantUuid");
  });

  it("uma mensagem absorvida ARMA a trava e não move o ponto de volta", () => {
    expect(source).toContain("if (absorbed) absorbedSinceFork = true;");
    // e guarda DE QUEM é o ponto: a memória só rebobina essa mensagem
    expect(source).toContain("else { forkPoint = lastAssistantUuid; forkText = text; absorbedSinceFork = false; }");
  });

  it("o truncamento vale por UM stream só — o seguinte continua da ponta nova", () => {
    const run = source.slice(source.indexOf("async function runStream()"));
    const set = run.indexOf("options.resumeSessionAt = pendingResumeAt;");
    const clear = run.indexOf("pendingResumeAt = null;");
    expect(set).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(set); // consumido na hora em que é usado
    // e nunca sem sessão: um resumeSessionAt sem resume não tem o que truncar
    expect(run).toContain("if (pendingResumeAt && lastSessionId) {");
  });

  it("a edição NUNCA some: os dois caminhos terminam mandando a mensagem", () => {
    const fn = source.slice(source.indexOf("async function rewindAndSend("), source.indexOf("/* ------------------------------------------------------------- stdin */"));
    // recusa -> supersede; falha ao derrubar o stream -> supersede; sucesso -> texto limpo
    expect(fn.match(/sendUser\(/g) ?? []).toHaveLength(2); // o do supersede e o do sucesso
    expect(fn.match(/\bsupersede\("/g) ?? []).toHaveLength(1); // falha ao derrubar
    expect(fn).toContain("supersede(decision.reason)"); // recusa
    expect(fn).toContain("} catch {");
    // e o plano B cai pro texto limpo se o manager não mandou fallback nenhum
    expect(fn.match(/typeof fallback === "string" && fallback !== "" \? fallback : text/g) ?? []).toHaveLength(1);
  });

  it("a mensagem vai ANTES de liberar os cartões de pergunta (mesma ordem do envio normal)", () => {
    // A janela é o RAMO do `edit_user`, não um número de caracteres: um comentário a mais ali
    // dentro não é uma regressão, e foi o que esta medida de 600 chars passou a chamar de uma.
    const handler = source.slice(source.indexOf('control.type === "edit_user"'), source.indexOf('control.type === "permission_decision"'));
    expect(handler).toContain("rewindAndSend(control.text, control.fallback, control.original, supersedePendingQuestions)");
    // supersede: as palavras entram ANTES de soltar; rebobinar: solta antes de derrubar o turno
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
    expect(memory).toBeGreaterThan(disk); // a memória só decide quando o disco não achou
    expect(teardown).toBeGreaterThan(memory); // e o stream só cai quando VAI rebobinar
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
    // com teto: um stream que nunca solta não pode travar a edição pra sempre
    expect(fn).toMatch(/i < \d+ && currentQuery === dying/);
  });
});

/**
 * EDITAR = VOLTAR NO TEMPO, para QUALQUER mensagem e depois de QUALQUER reinício. O bug reportado:
 * editar uma mensagem criava uma mensagem nova embaixo (supersede) em vez de apagar o que veio
 * depois — porque o ponto de volta só existia na memória do driver, só para a última mensagem, e
 * sumia quando o driver era derrubado por ociosidade ou deploy. O transcript da sessão em disco tem
 * a cadeia inteira; daqui sai o ponto de volta de qualquer mensagem.
 */
describe("sdk-driver.mjs — forkPointFromTranscript acha o ponto de volta no disco", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");
  type Fork = { found: false } | { found: true; uuid: string | null };
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
    // "velha" foi editada antes: a sessão voltou para a1 e seguiu por "nova". O arquivo guarda os dois.
    const jsonl = [
      user("u1", null, "oi"),
      assistant("a1", "u1"),
      user("old", "a1", "velha"),
      assistant("aold", "old"),
      user("new", "a1", "nova"),
      assistant("anew", "new"),
    ].join("\n");
    expect(forkPointFromTranscript(jsonl, "velha")).toEqual({ found: false });
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
    // "continua" foi um turno (u2) e depois entrou de novo no meio de outro turno (queued_command).
    // A tela edita a MAIS NOVA; casar com u2 rebobinaria turnos que a tela vai manter.
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

  it("texto que não está na conversa, ou transcript vazio: não achou (o driver cai no plano B)", () => {
    expect(forkPointFromTranscript(conversa, "nunca dita")).toEqual({ found: false });
    expect(forkPointFromTranscript("", "oi")).toEqual({ found: false });
    expect(forkPointFromTranscript(conversa, "   ")).toEqual({ found: false });
  });
});

/**
 * A EDIÇÃO NÃO DEIXA UM ERRO VERMELHO PRA TRÁS.
 *
 * Editar uma mensagem no meio de um turno termina em dois balões vermelhos que não deveriam
 * existir, e os dois saem do mesmo lugar: o CLI encerra um turno INTERROMPIDO como
 * `error_during_execution` carregando só um diagnóstico interno
 * (`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`), e o Agent SDK,
 * quando a corrente fecha depois disso, troca o erro de saída por
 * `Error("Claude Code returned an error result: " + errors.join("; "))`. O rebobinar FECHA a
 * corrente de propósito — logo, ele mesmo provocava o banner (produção, 2026-10-01).
 *
 * O próprio CLI não mostra nada disso a ninguém: ele filtra `[ede_diagnostic]` da sua saída e só
 * exibe um `error_during_execution` quando o fim NÃO foi um abort. Estes testes rodam as duas
 * funções puras que põem o driver na mesma régua.
 */
describe("sdk-driver.mjs — um turno interrompido não é um turno que falhou", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  /** Recorta uma função pura do driver e a executa de verdade (como o `rewindDecision` acima). */
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
    // O CLI esconde `[session_crash]` da própria UI, mas ali ele tem outras formas de contar. Aqui,
    // engolir significaria um turno que para sem resposta, sem erro e sem explicação nenhuma.
    expect(humanErrorText("[session_crash] worker died")).toBe("[session_crash] worker died");
    expect(humanErrorText("Claude Code returned an error result: [session_crash] worker died"))
      .toBe("Claude Code returned an error result: [session_crash] worker died");
  });

  it("um diagnóstico com ponto e vírgula dentro não vaza o rabo como se fosse erro", () => {
    // O corte é no separador do SDK ("; "), não em qualquer ";": senão a metade de um diagnóstico
    // virava uma frase vermelha sozinha na conversa.
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
    // `query()` estoura SÍNCRONO (opção inválida, binário faltando) e nessa hora `myQuery` ainda é
    // null — o mesmo valor de `closingQuery` em repouso. Sem a trava, o erro de partida seria lido
    // como teardown nosso: sem `error`, sem `result` (o `finally` não fecha um turno que ainda não
    // tinha sido marcado) e a mensagem sumindo com o spinner preso.
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("let myQuery = null;");
    expect(run).toContain("if (myQuery !== null && closingQuery === myQuery) trace(");
    // e `myQuery` só existe DEPOIS de `query()` ter devolvido sem estourar
    const assign = run.indexOf("currentQuery = query({ prompt: myChannel, options });");
    expect(run.indexOf("myQuery = currentQuery;")).toBeGreaterThan(assign);
  });

  it("a corrente derrubada pelo rebobinar não vira erro na tela", () => {
    const teardown = source.slice(source.indexOf("async function endStream()"), source.indexOf("async function rewindAndSend("));
    expect(teardown).toContain("closingQuery = dying;");
    // reivindicada ANTES do primeiro passo que pode matá-la
    expect(teardown.indexOf("closingQuery = dying;")).toBeLessThan(teardown.indexOf("dying.interrupt()"));

    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("closingQuery === myQuery) trace(");
    // e a reivindicação não vaza para a corrente seguinte
    expect(run).toContain("if (closingQuery === myQuery) closingQuery = null;");
  });

  it("só o stream VIGENTE encerra turno e larga o handle — o que sobreviveu ao teardown não manda", () => {
    // Quando `endStream` desiste de esperar, o stream velho segue vivo ao lado do novo. Sem a
    // guarda de identidade, o `finally` dele fechava o turno NOVO e zerava o `currentQuery` VIVO —
    // e com ele o botão de parar, que vira um no-op sem dizer nada a ninguém.
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("const stillOurs = currentQuery === myQuery;");
    expect(run).toContain("if (stillOurs && turnActive) {");
    expect(run).toContain("if (stillOurs) currentQuery = null;");
  });

  it("o que é engolido ainda é registrado — no stderr, nunca no stdout do protocolo", () => {
    expect(source).toContain("process.stderr.write(`[sdk-driver] ${line}\\n`)");
    const run = source.slice(source.indexOf("async function runStream()"));
    expect(run).toContain("trace(`stream error with nothing to tell:");
  });
});

/**
 * A CONVERSA QUE ANDOU FORA DO CHAT (produção, 2026-10-05). O César editou uma mensagem e nada
 * rebobinou: ela tinha vindo da aba Terminal, que fala com a MESMA sessão por OUTRO processo do
 * CLI. A corrente aberta do chat carrega a conversa em memória, então a mensagem seguinte do chat
 * continuou de um ponto ANTERIOR e deixou o turno do terminal num galho morto — e galho morto não
 * tem ponto de volta (`forkPointFromTranscript` só anda no ramo vivo, de propósito), então a edição
 * caía no supersede.
 *
 * O conserto não é afrouxar o fork point: é não deixar o galho morto nascer. O back avisa
 * (`reanchor`), o driver MARCA, e o próximo envio reabre a corrente no fim real do arquivo.
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
    // o `return` do catch vem ANTES de a marca ser baixada
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
 * O RACIOCÍNIO NA LÍNGUA DE QUEM LÊ. O bloco "Raciocínio" saía sempre em inglês — e nem todo mundo
 * na operação lê inglês, então era tela morta. Segue o idioma da INTERFACE, que mora no navegador.
 */
describe("sdk-driver.mjs — em que idioma o modelo pensa", () => {
  const source = readFileSync(new URL("./sdk-driver.mjs", import.meta.url), "utf8");

  function cut<T>(name: string): T {
    const from = source.indexOf(`function ${name}(`);
    expect(from).toBeGreaterThan(0);
    return new Function(`${source.slice(from, source.indexOf("\n}", from) + 2)}\nreturn ${name};`)() as T;
  }
  const normalizeLanguage = cut<(t: unknown) => string | null>("normalizeLanguage");
  const reasoningInstruction = cut<(l: unknown) => string>("reasoningInstruction");

  it("reconhece as duas línguas do painel, com ou sem região", () => {
    expect(normalizeLanguage("pt-BR")).toBe("pt-BR");
    expect(normalizeLanguage("pt")).toBe("pt-BR");
    expect(normalizeLanguage("PT-br")).toBe("pt-BR");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("en")).toBe("en");
  });

  it("qualquer outra coisa é o PADRÃO do modelo, nunca um palpite", () => {
    expect(normalizeLanguage("fr")).toBe(null);
    expect(normalizeLanguage("")).toBe(null);
    expect(normalizeLanguage(undefined)).toBe(null);
    expect(normalizeLanguage(null)).toBe(null);
    expect(normalizeLanguage(42)).toBe(null);
  });

  it("em português, manda escrever o RACIOCÍNIO em português — e só ele", () => {
    const instruction = reasoningInstruction("pt-BR");
    expect(instruction).toContain("racioc");
    expect(instruction).toContain("portugu");
  });

  it("inglês (e desconhecido) não anexa nada: é o padrão do modelo, e parágrafo tem custo", () => {
    expect(reasoningInstruction("en")).toBe("");
    expect(reasoningInstruction(null)).toBe("");
    expect(reasoningInstruction(undefined)).toBe("");
  });

  it("o idioma entra como APPEND do preset — trocar o preset custaria o CLAUDE.md e as ferramentas", () => {
    const opts = source.slice(source.indexOf("function baseOptions()"), source.indexOf("/* ------------------------------------------- the command catalogue"));
    expect(opts).toContain('{ type: "preset", preset: "claude_code", append: reasoningInstruction(reasoningLanguage) }');
    // sem idioma, o objeto é exatamente o de antes — nenhuma chave `append` vazia
    expect(opts).toContain('{ type: "preset", preset: "claude_code" }');
  });

  it("trocar o idioma vale do turno seguinte, sem respawn: o controle só move a variável", () => {
    const at = source.indexOf('control.type === "language"');
    expect(at).toBeGreaterThan(0);
    const branch = source.slice(at, at + 260);
    expect(branch).toContain("reasoningLanguage = normalizeLanguage(control.language);");
    // `baseOptions()` é relido a cada stream, então nada precisa ser derrubado aqui
    expect(branch).not.toContain("endStream(");
  });

  it("não nomeia o mecanismo interno — é isso que o classificador do Opus caça (card #3684)", () => {
    // claude-code#93584 documenta o safeguard disparando ao citar o PRÓPRIO raciocínio que a tela
    // já mostra. A instrução pede o idioma sem nomear "thinking"/"chain of thought" — só "raciocínio".
    const instruction = reasoningInstruction("pt-BR");
    expect(instruction.toLowerCase()).not.toContain("thinking");
    expect(instruction.toLowerCase()).not.toContain("chain of thought");
  });
});

/**
 * O OPUS BLOQUEAVA TODA MENSAGEM DO CHAT (card #3684, 2026-10-06). O erro cru da Anthropic —
 * `safeguards flagged this message ... [reasoning_extraction]` — é um falso positivo DOCUMENTADO do
 * classificador de segurança do Opus (claude-code#93584, #89503, #95275, entre outras dezenas de
 * issues públicas): o SERVIDOR marca uma conversa benigna, não o conteúdo dela. Não há como o
 * driver evitar o bloqueio em si (ele nasce do lado da Anthropic, antes da resposta chegar), mas
 * duas coisas estavam no alcance do código:
 *
 *   1. a instrução de idioma do raciocínio (acima) citava "os blocos de thinking" — vocabulário
 *      técnico que o próprio #93584 mostra como gatilho conhecido. Suavizada para falar só em
 *      "raciocínio", sem o jargão do mecanismo interno.
 *   2. a mensagem que chega ao humano trazia só o texto cru em inglês, sem explicar que é um bug
 *      conhecido do classificador e não algo sobre a pergunta feita.
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
    expect(run).toContain('emit({ type: "error", message: humanizeSafeguardError(detail) });');
  });
});

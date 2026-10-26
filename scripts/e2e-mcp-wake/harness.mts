/**
 * E2E (real Claude, real SDK driver, real tmux) of orders arriving through the EXTERNAL MCP — what
 * ChatGPT does — with no browser anywhere. Phases (argv[2]):
 *   main        : new card + immediate send, old card (context kept) after hibernation, two orders at
 *                 once to a sleeping card, paused card refused, idle sweep mid-task, driver crash mid-tool.
 *   deploy-a    : sends a long task and waits; the shell SIGKILLs this whole process group mid-tool.
 *   deploy-b    : the "new deploy": boot resume sweep, then waits for the task to finish.
 * State lives in $E2E_DATA (board, history, inflight markers), shared between phases.
 */
const B = process.env.E2E_BACK + "/src";
setInterval(() => undefined, 1000); // a real server keeps the loop alive (listen); the harness must too
const PHASE = process.argv[2] ?? "main";
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
const env = await import(`${B}/config/env.ts`);
const registry = await import(`${B}/services/board/registry.ts`);
await import(`${B}/services/board/status.ts`); // the status sink the driver reports into
const workspace = await import(`${B}/services/board/workspace.ts`);
const manager = await import(`${B}/services/sdk/manager.ts`);
const resume = await import(`${B}/services/sdk/resume.ts`);
const inflight = await import(`${B}/services/sdk/inflight.ts`);
const users = await import(`${B}/auth/users.ts`);
const settings = await import(`${B}/services/settings/settings.ts`);
const { createMcpServer } = await import(`${B}/mcp/server.ts`);
const { Client } = await import(process.env.E2E_BACK + "/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { InMemoryTransport } = await import(process.env.E2E_BACK + "/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");

const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", name, detail); };

inflight.startInflightOwnerHeartbeat();
manager.onDriverCrashWithWork((cardId, marker) => { void resume.resumeAfterDriverCrash(cardId, marker); });
await settings.updateSettings({ sdkDriver: true, sdkAutoResume: true, idleHibernateMinutes: 180 });

const statePath = `${env.config.dataDir}/e2e-state.json`;
const state: Record<string, string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state));

const existing = (await users.listUsers()).find((u: { username: string }) => u.username === "e2e");
const ownerPub = existing ?? users.publicUser(await users.createUser("e2e", "senha-forte-e2e-123", "owner"));
let project = (await registry.listProjects()).find((p: { name: string }) => p.name === "e2e");
if (!project) project = await registry.createProject({ name: "e2e" });

const server = createMcpServer("external", ownerPub);
const [cs, ss] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "chatgpt-e2e", version: "1" });
await Promise.all([server.connect(ss), client.connect(cs)]);
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: text }; }
}
/** Waits for the turn sent at `since` to end (vibehub_wait_for_card, re-called on timeout). */
async function waitDone(cardId: string, since: number, maxMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const out = await call("vibehub_wait_for_card", { cardId, since, timeoutSeconds: 45 });
    if (out.outcome !== "timeout" || Date.now() - t0 > maxMs) return out;
  }
}
const cwdOf = async (cardId: string) => workspace.cardWorkPaths(project, (await registry.getCard(cardId))!).cwd;
async function newCard(title: string, open: boolean) {
  const out = await call("vibehub_create_card", { projectId: project.id, title, open });
  if (out.error) throw new Error(String(out.error));
  await registry.updateCard(String(out.cardId), { model: "haiku" }).catch(() => undefined);
  return String(out.cardId);
}
async function send(cardId: string, text: string) {
  const out = await call("vibehub_send_to_terminal", { cardId, text });
  return out;
}
function historyHas(cardId: string, pred: (e: Record<string, unknown>) => boolean): boolean {
  const f = `${env.config.dataDir}/sdk-history/${cardId}.ndjson`;
  if (!existsSync(f)) return false;
  return readFileSync(f, "utf8").split("\n").some((l) => { try { return pred(JSON.parse(l)); } catch { return false; } });
}

async function main() {
  if (!process.env.E2E_ONLY_CRASH) await basics();
  await crash();
}

async function basics() {
  // S1: NEW card — create (open) and send IMMEDIATELY; the work must really happen.
  const c1 = await newCard("e2e novo", true);
  let since = Date.now();
  let out = await send(c1, "Use a ferramenta Bash para criar o arquivo e2e-new.txt contendo exatamente ok-new no diretório atual. Depois responda apenas FEITO.");
  check("S1 send to a brand-new card", out.sent === true, JSON.stringify(out).slice(0, 200));
  let done = await waitDone(c1, since);
  const f1 = `${await cwdOf(c1)}/e2e-new.txt`;
  check("S1 turn finished and the artifact exists", done.outcome === "finished" && existsSync(f1) && readFileSync(f1, "utf8").includes("ok-new"),
    `outcome=${done.outcome} file=${existsSync(f1)} answers=${JSON.stringify(done.answers ?? []).slice(0, 120)}`);

  // S2: OLD card — a remembered word, then HIBERNATION (driver and tmux killed), then an order.
  since = Date.now();
  await send(c1, "Memorize a palavra-chave ABACAXI-42 para depois. Responda apenas OK.");
  await waitDone(c1, since);
  const hib = await workspace.hibernateCard(c1, "e2e");
  check("S2 card hibernated (sessions killed)", !!hib && !manager.liveDriverSession(c1), `hibernatedAt=${hib?.hibernatedAt}`);
  since = Date.now();
  out = await send(c1, "Qual era a palavra-chave que pedi para memorizar? Responda apenas a palavra.");
  check("S2 order to a hibernated card wakes it (no browser)", out.sent === true && out.woke === true && out.route === "sdk-driver", JSON.stringify(out).slice(0, 200));
  done = await waitDone(c1, since);
  check("S2 context preserved across the hibernation", done.outcome === "finished" && JSON.stringify(done.answers ?? []).includes("ABACAXI-42"),
    `outcome=${done.outcome} answers=${JSON.stringify(done.answers ?? []).slice(0, 160)}`);

  // S3: two orders AT ONCE to a card that was never opened.
  const c3 = await newCard("e2e simultaneo", false);
  since = Date.now();
  const [a, b] = await Promise.all([
    send(c3, "Crie com Bash o arquivo um.txt contendo 1. Responda apenas UM."),
    send(c3, "Crie com Bash o arquivo dois.txt contendo 2. Responda apenas DOIS."),
  ]);
  check("S3 both concurrent orders accepted", a.sent === true && b.sent === true, `${JSON.stringify(a).slice(0, 120)} | ${JSON.stringify(b).slice(0, 120)}`);
  for (let i = 0; i < 3; i++) { done = await waitDone(c3, since); if (existsSync(`${await cwdOf(c3)}/um.txt`) && existsSync(`${await cwdOf(c3)}/dois.txt`)) break; await sleep(5000); }
  const cwd3 = await cwdOf(c3);
  check("S3 both orders executed, ONE driver", existsSync(`${cwd3}/um.txt`) && existsSync(`${cwd3}/dois.txt`), `um=${existsSync(`${cwd3}/um.txt`)} dois=${existsSync(`${cwd3}/dois.txt`)}`);

  // S6: a PAUSED card is refused, never woken.
  await workspace.pauseCard(c3, "e2e");
  out = await send(c3, "continua");
  check("S6 paused card refused with a clear error", String(out.error ?? "").startsWith("paused:") && !manager.liveDriverSession(c3), String(out.error ?? JSON.stringify(out)).slice(0, 160));

}

async function crash() {
  // S4 + S5: a long tool, the idle sweep mid-task (must spare it), then the driver CRASHES mid-tool.
  const c4 = await newCard("e2e interrompido", true);
  let done: Record<string, unknown>;
  const out = await send(c4, "Execute exatamente este comando com a ferramenta Bash, em primeiro plano (sem background): python3 -c 'import time; time.sleep(40)' && echo fim > e2e-int-a.txt . Quando terminar, crie também com Bash o arquivo e2e-int-b.txt contendo ok-int e responda apenas FEITO.");
  check("S4 long task accepted", out.sent === true, JSON.stringify(out).slice(0, 160));
  for (let i = 0; i < 60 && !historyHas(c4, (e) => e.type === "tool_use" && JSON.stringify(e.input ?? "").includes("time.sleep")); i++) await sleep(1000);
  await sleep(4000);
  const swept = await workspace.sweepIdleCards(Date.now() + 6 * 60 * 60_000);
  const c4card = await registry.getCard(c4);
  check("S5 idle sweep 6h 'later' does not hibernate a card mid-task", !c4card?.hibernatedAt && !!manager.liveDriverSession(c4), `swept=${swept} status=${c4card?.status}`);
  const drv = manager.liveDriverSession(c4)!;
  const pid = drv.child.pid;
  log("killing the driver process tree mid-tool, pid", pid);
  const { execSync } = await import("node:child_process");
  // the WHOLE tree at once (bash -> node driver -> claude -> the running tool), like the docker exec
  // dying with the back: collect descendants first, then SIGKILL them together.
  const tree = (root: number): number[] => {
    const rows = execSync("ps -eo pid=,ppid=", { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const out = [root];
    for (let i = 0; i < out.length; i++) for (const [p, pp] of rows) if (pp === out[i] && !out.includes(p)) out.push(p);
    return out;
  };
  const victims = tree(pid!);
  log("victims", victims.length);
  for (const v of victims) { try { process.kill(v, "SIGKILL"); } catch { /* gone */ } }
  done = { outcome: "pending" } as Record<string, unknown>;
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    await sleep(5000);
    if (existsSync(`${await cwdOf(c4)}/e2e-int-b.txt`)) break;
  }
  const cwd4 = await cwdOf(c4);
  const resumedNote = historyHas(c4, (e) => e.type === "system_note");
  check("S4 driver crash mid-tool: resumed with no human and the task COMPLETED",
    existsSync(`${cwd4}/e2e-int-b.txt`) && resumedNote,
    `a=${existsSync(`${cwd4}/e2e-int-a.txt`)} b=${existsSync(`${cwd4}/e2e-int-b.txt`)} systemNote=${resumedNote}`);
  const userTurns = readFileSync(`${env.config.dataDir}/sdk-history/${c4}.ndjson`, "utf8").split("\n").filter((l) => l.includes('"type":"user"')).length;
  check("S4 no resume loop / duplicate orders", userTurns <= 3, `user lines in history=${userTurns}`);
  state.cleanup = JSON.stringify([...(state.cleanup ? JSON.parse(state.cleanup) : []), c4]);
  save();
}

async function deployA() {
  const c5 = await newCard("e2e deploy", true);
  state.deployCard = c5;
  save();
  const since = Date.now();
  state.deploySince = String(since);
  save();
  const out = await send(c5, "Execute com a ferramenta Bash, em primeiro plano: python3 -c 'import time; time.sleep(45)' && echo fim > e2e-dep-a.txt . Quando terminar, crie com Bash o arquivo e2e-dep-b.txt contendo ok-dep e responda apenas FEITO.");
  log("deploy-a send:", JSON.stringify(out).slice(0, 200));
  for (let i = 0; i < 90 && !historyHas(c5, (e) => e.type === "tool_use" && JSON.stringify(e.input ?? "").includes("time.sleep")); i++) await sleep(1000);
  log("TOOL_RUNNING"); // the shell kills this whole process group now (docker rm -f of the old container)
  await sleep(600_000);
}

async function deployB() {
  const c5 = state.deployCard!;
  log("new instance booting; marker present:", existsSync(`${env.config.dataDir}/sdk-inflight/${c5}.json`));
  const summary = await resume.resumeInterruptedTurns();
  check("D boot resume picked the interrupted turn", summary.resumed.includes(c5), JSON.stringify(summary));
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000 && !existsSync(`${await cwdOf(c5)}/e2e-dep-b.txt`)) await sleep(5000);
  const cwd5 = await cwdOf(c5);
  check("D after a deploy mid-tool the task COMPLETED with no human", existsSync(`${cwd5}/e2e-dep-b.txt`), `a=${existsSync(`${cwd5}/e2e-dep-a.txt`)} b=${existsSync(`${cwd5}/e2e-dep-b.txt`)}`);
  const lines = readFileSync(`${env.config.dataDir}/sdk-history/${c5}.ndjson`, "utf8").split("\n");
  const sys = lines.filter((l) => l.includes('"system_note"')).length;
  const users2 = lines.filter((l) => l.includes('"type":"user"')).length;
  check("D exactly one continuation (no duplicate turns)", users2 === 2, `user lines=${users2} system notes=${sys}`);
  const card = await registry.getCard(c5);
  state.cleanup = JSON.stringify([...(state.cleanup ? JSON.parse(state.cleanup) : []), c5]);
  save();
  log("final status", card?.status);
}

async function extra() {
  const readHist = (cardId: string) => {
    const f = `${env.config.dataDir}/sdk-history/${cardId}.ndjson`;
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  };
  // X1: a REAL idle period — the turn ends, the idle sweep (4 h "later") puts the card to sleep by
  // itself, and an order afterwards wakes it with the conversation intact.
  const c = await newCard("e2e inativo", true);
  let since = Date.now();
  await send(c, "Memorize a palavra-chave KIWI-77 para depois. Responda apenas OK.");
  let done = await waitDone(c, since);
  check("X1 first turn finished", done.outcome === "finished", `outcome=${done.outcome}`);
  for (let i = 0; i < 20 && manager.driverTurnRunning(c); i++) await sleep(500);
  const swept = await workspace.sweepIdleCards(Date.now() + 4 * 60 * 60_000);
  const slept = await registry.getCard(c);
  check("X1 idle sweep hibernates the card that really went quiet", !!slept?.hibernatedAt && !manager.liveDriverSession(c), `swept=${swept} hibernatedAt=${slept?.hibernatedAt}`);
  since = Date.now();
  let out = await send(c, "Qual era a palavra-chave que pedi para memorizar? Responda apenas a palavra.");
  done = await waitDone(c, since);
  check("X1 order after the idle period wakes it and the context survives",
    out.woke === true && done.outcome === "finished" && JSON.stringify(done.answers ?? []).includes("KIWI-77"),
    `woke=${out.woke} outcome=${done.outcome} answers=${JSON.stringify(done.answers ?? []).slice(0, 120)}`);

  // X2: the driver stopped on its own idle clock (DRIVER_IDLE_MS) while the card stays "live".
  for (let i = 0; i < 20 && manager.driverTurnRunning(c); i++) await sleep(500);
  manager.stopCardDriver(c);
  since = Date.now();
  out = await send(c, "Repita a palavra-chave de antes, só ela.");
  done = await waitDone(c, since);
  check("X2 order after the driver's idle stop restarts it with the context",
    out.sent === true && out.route === "sdk-driver" && JSON.stringify(done.answers ?? []).includes("KIWI-77"),
    `route=${out.route} outcome=${done.outcome} answers=${JSON.stringify(done.answers ?? []).slice(0, 120)}`);

  // X3: a SECOND order arrives while the first is mid-tool — both must be carried out.
  since = Date.now();
  out = await send(c, "Execute com a ferramenta Bash, em primeiro plano: python3 -c 'import time; time.sleep(25)' && echo 1 > x3-a.txt . Depois responda apenas A-FEITO.");
  for (let i = 0; i < 60 && !readHist(c).some((e) => e.at >= since && e.type === "tool_use"); i++) await sleep(1000);
  const out2 = await send(c, "Também crie com Bash o arquivo x3-b.txt contendo 2. Responda apenas B-FEITO.");
  const cwd = await cwdOf(c);
  for (let i = 0; i < 36 && !(existsSync(`${cwd}/x3-a.txt`) && existsSync(`${cwd}/x3-b.txt`)); i++) await sleep(5000);
  done = await waitDone(c, since);
  check("X3 an order sent mid-tool is queued and both are executed",
    out2.sent === true && existsSync(`${cwd}/x3-a.txt`) && existsSync(`${cwd}/x3-b.txt`),
    `second=${JSON.stringify(out2).slice(0, 100)} a=${existsSync(`${cwd}/x3-a.txt`)} b=${existsSync(`${cwd}/x3-b.txt`)}`);

  // X4: a tool that TIMES OUT mid-turn — the turn goes on and finishes by itself.
  since = Date.now();
  await send(c, "Rode com a ferramenta Bash, usando o parâmetro timeout de 5000 ms, o comando python3 -c 'import time; time.sleep(60)'. Quando ele estourar o tempo, crie com Bash o arquivo x4.txt contendo timeout-ok e responda apenas FEITO.");
  done = await waitDone(c, since);
  check("X4 tool timeout mid-turn: the turn still completes", existsSync(`${cwd}/x4.txt`) && done.outcome === "finished",
    `outcome=${done.outcome} file=${existsSync(`${cwd}/x4.txt`)}`);

  // X5: Done. A finished card whose session is still up takes an order; asleep, it is refused clearly.
  const mv = await call("vibehub_move_cards", { cards: [c], column: "done" });
  since = Date.now();
  out = await send(c, "Crie com Bash o arquivo x5.txt contendo done-ok. Responda apenas FEITO.");
  done = await waitDone(c, since);
  check("X5 a Done card with a live session still carries out an order", out.sent === true && existsSync(`${cwd}/x5.txt`),
    `move=${JSON.stringify(mv).slice(0, 80)} out=${JSON.stringify(out).slice(0, 100)} file=${existsSync(`${cwd}/x5.txt`)}`);
  // that order was a NEW turn, which brings a Done card back to the active columns (by design) —
  // conclude it again before putting it to sleep
  const backFromDone = (await registry.getCard(c))?.column;
  for (let i = 0; i < 20 && manager.driverTurnRunning(c); i++) await sleep(500);
  await call("vibehub_move_cards", { cards: [c], column: "done" });
  await workspace.hibernateCard(c, "e2e");
  log("X5 column after the order to the Done card:", backFromDone);
  out = await send(c, "x");
  check("X5 a Done card asleep is refused with `done:` (no silent loss)", String(out.error ?? "").includes("done:"), String(out.error ?? JSON.stringify(out)).slice(0, 140));

  // X6: what was said is persisted with its sender, and the end of each turn is observable.
  const hist = readHist(c);
  const users2 = hist.filter((e) => e.type === "user");
  const card = await registry.getCard(c);
  check("X6 every order persisted with its sender, and the card ends idle (not stuck working)",
    users2.length >= 7 && users2.every((u) => u.from?.name === "e2e") && card?.status !== "working",
    `userLines=${users2.length} senders=${[...new Set(users2.map((u) => u.from?.name))]} status=${card?.status}`);
  state.cleanup = JSON.stringify([...(state.cleanup ? JSON.parse(state.cleanup) : []), c]);
  save();
}

async function apiRetry() {
  // R: the API is unreachable when the turn starts (a proxy in front of it drops every connection for
  // the first seconds) and the CLI is told not to retry on its own: the turn ENDS in "API Error".
  // The card must come back by itself once the network is back — nobody types "continua".
  const http = await import("node:http");
  const https = await import("node:https");
  let firstAt = 0;
  let dropped = 0;
  let forwarded = 0;
  const OUTAGE_MS = 20_000;
  const proxy = http.createServer((req, res) => {
    if (!firstAt) firstAt = Date.now();
    if (Date.now() - firstAt < OUTAGE_MS) { dropped += 1; req.socket.destroy(); return; }
    forwarded += 1;
    const up = https.request({ host: "api.anthropic.com", port: 443, path: req.url, method: req.method, headers: { ...req.headers, host: "api.anthropic.com" } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const port = (proxy.address() as import("node:net").AddressInfo).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.CLAUDE_CODE_MAX_RETRIES = "0";
  const c = await newCard("e2e api fora", true);
  const since = Date.now();
  const out = await send(c, "Crie com a ferramenta Bash o arquivo r.txt contendo api-ok no diretório atual. Depois responda apenas FEITO.");
  check("R order accepted", out.sent === true, JSON.stringify(out).slice(0, 160));
  const cwd = await cwdOf(c);
  // what ChatGPT does: wait for the turn. The FIRST "finished" it gets must be the real end, not the
  // error the panel is already retrying (that answer is what made it send "continua").
  const first = await waitDone(c, since, 240_000);
  const fileAtFirstFinish = existsSync(`${cwd}/r.txt`);
  check("R the first 'finished' ChatGPT sees is the real end (the retry wait counts as the turn)",
    first.outcome === "finished" && fileAtFirstFinish && JSON.stringify(first.answers ?? []).includes("FEITO"),
    `outcome=${first.outcome} file=${fileAtFirstFinish} answers=${JSON.stringify(first.answers ?? []).slice(0, 160)}`);
  for (let i = 0; i < 60 && !existsSync(`${cwd}/r.txt`); i++) await sleep(5000);
  const hist = readFileSync(`${env.config.dataDir}/sdk-history/${c}.ndjson`, "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const notes = hist.filter((e) => e.type === "system_note").map((e) => e.text);
  const retries = hist.filter((e) => e.type === "user" && e.from?.kind === "system").length;
  check("R a turn killed by the API outage came back by itself and the task COMPLETED",
    existsSync(`${cwd}/r.txt`) && retries >= 1 && dropped > 0,
    `file=${existsSync(`${cwd}/r.txt`)} dropped=${dropped} forwarded=${forwarded} retries=${retries} notes=${JSON.stringify(notes).slice(0, 200)}`);
  state.cleanup = JSON.stringify([...(state.cleanup ? JSON.parse(state.cleanup) : []), c]);
  save();
  proxy.close();
}

try {
  if (PHASE === "apiretry") await apiRetry();
  else if (PHASE === "extra") await extra();
  else if (PHASE === "main") await main();
  else if (PHASE === "deploy-a") await deployA();
  else if (PHASE === "deploy-b") await deployB();
} catch (err) {
  check(`phase ${PHASE} crashed`, false, (err as Error).stack ?? String(err));
}
log("SUMMARY", JSON.stringify(results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name}`), null, 1));
manager.shutdownAllDrivers();
process.exit(results.every((r) => r.ok) ? 0 : 1);

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

try {
  if (PHASE === "main") await main();
  else if (PHASE === "deploy-a") await deployA();
  else if (PHASE === "deploy-b") await deployB();
} catch (err) {
  check(`phase ${PHASE} crashed`, false, (err as Error).stack ?? String(err));
}
log("SUMMARY", JSON.stringify(results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name}`), null, 1));
manager.shutdownAllDrivers();
process.exit(results.every((r) => r.ok) ? 0 : 1);

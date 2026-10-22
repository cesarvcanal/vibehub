/** Same scenario on the OLD code (E2E_SRC=src-old, main before this branch) and on the NEW one. */
const B = process.env.E2E_BACK + "/" + (process.env.E2E_SRC ?? "src");
setInterval(() => undefined, 1000);
const env = await import(`${B}/config/env.ts`);
const registry = await import(`${B}/services/board/registry.ts`);
await import(`${B}/services/board/status.ts`);
const workspace = await import(`${B}/services/board/workspace.ts`);
const manager = await import(`${B}/services/sdk/manager.ts`);
const users = await import(`${B}/auth/users.ts`);
const settings = await import(`${B}/services/settings/settings.ts`);
const { createMcpServer } = await import(`${B}/mcp/server.ts`);
const { Client } = await import(process.env.E2E_BACK + "/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { InMemoryTransport } = await import(process.env.E2E_BACK + "/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
const tag = process.env.E2E_SRC === "src-old" ? "OLD" : "NEW";
const log = (...a: unknown[]) => console.log(`[${tag} ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await settings.updateSettings({ sdkDriver: true, sdkAutoResume: true, idleHibernateMinutes: 180 });
const ownerPub = users.publicUser(await users.createUser("e2e", "senha-forte-e2e-123", "owner"));
const project = await registry.createProject({ name: "e2e" });
const server = createMcpServer("external", ownerPub);
const [cs, ss] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "chatgpt-e2e", version: "1" });
await Promise.all([server.connect(ss), client.connect(cs)]);
const call = async (name: string, args: Record<string, unknown>) => {
  const t = ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
  try { return JSON.parse(t); } catch { return { error: t }; }
};
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
// An OLD card: first opened 10 h ago (openedAt is stamped once), hibernated since, like the voice card.
const created = await call("vibehub_create_card", { projectId: project.id, title: `e2e ${tag}`, open: true });
const id = created.cardId as string;
await registry.updateCard(id, { model: "haiku" });
const f = `${env.config.dataDir}/board.json`;
const doc = JSON.parse(readFileSync(f, "utf8"));
doc.cards.find((c: { id: string }) => c.id === id).openedAt = Date.now() - 10 * 3600_000;
writeFileSync(f, JSON.stringify(doc));
await workspace.hibernateCard(id, "e2e");
const cwd = workspace.cardWorkPaths(project, (await registry.getCard(id))!).cwd;
// 1) ChatGPT sends straight to the sleeping card.
let out = await call("vibehub_send_to_terminal", { cardId: id, text: "x" });
log("1) send to the hibernated card:", JSON.stringify(out).slice(0, 220));
// 2) ChatGPT does what it did in production: open, then send a task that takes a while.
if (out.error) {
  log("2) open_card:", JSON.stringify(await call("vibehub_open_card", { cardId: id })).slice(0, 160));
  out = await call("vibehub_send_to_terminal", { cardId: id, text: "Execute com a ferramenta Bash, em primeiro plano: python3 -c 'import time; time.sleep(30)' && echo ok > ba.txt . Depois responda apenas FEITO." });
} else {
  out = await call("vibehub_send_to_terminal", { cardId: id, text: "Execute com a ferramenta Bash, em primeiro plano: python3 -c 'import time; time.sleep(30)' && echo ok > ba.txt . Depois responda apenas FEITO." });
}
log("2) send the task:", JSON.stringify(out).slice(0, 220));
await sleep(12_000);
// 3) The next idle-sweep tick lands mid-task (it runs every 5 min in production).
const swept = await workspace.sweepIdleCards(Date.now());
const c = await registry.getCard(id);
log(`3) idle sweep mid-task: hibernated=${swept} card.hibernatedAt=${c?.hibernatedAt ?? null} status=${c?.status ?? null}`);
for (let i = 0; i < 18 && !existsSync(`${cwd}/ba.txt`); i++) await sleep(5000);
log(`4) task artifact after 90 s: ${existsSync(`${cwd}/ba.txt`) ? "PRESENT (work completed)" : "MISSING (work lost)"}`);
console.log("BOARD", JSON.stringify({ tmux: c?.tmuxSession, slug: c?.worktreeSlug }));
manager.shutdownAllDrivers();
process.exit(0);

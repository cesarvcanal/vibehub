import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TIMELINE_PROBE_JS,
  DETAIL_TEXT_MAX,
  InvalidDetailIdError,
  TOOL_DETAIL_PROBE_JS,
  buildDetailProbeScript,
  parseAgentTimeline,
  parseToolDetail,
} from "./detail.js";
import { parseDetailFrame } from "./protocol.js";
import { createDetailResponder } from "./manager.js";
import { assertWorktreeRelativePath, buildFileDiffScript } from "../maestro/changes.js";

/** Um transcript como o Claude Code grava: a conversa principal e um subagente em segundo plano. */
const SESSION = "11111111-2222-3333-4444-555555555555";
const line = (o: object): string => JSON.stringify(o);
let dir = "";
const BG_DIR = (): string => join(dir, "bg", SESSION, "tasks");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vh-detail-"));
  const main = [
    line({ type: "user", timestamp: "2026-10-19T20:41:00.000Z", message: { role: "user", content: "revisa as PRs" } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:41:05.000Z", message: { content: [{ type: "thinking", thinking: "Primeiro a lista das PRs." }] } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:41:06.000Z", message: { content: [{ type: "tool_use", id: "toolu_bash1", name: "Bash", input: { command: "gh pr list", description: "Lista as PRs" } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:41:07.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash1", content: "#510 a\n#511 b\n" }] }, toolUseResult: { stdout: "#510 a\n#511 b\n", stderr: "", interrupted: false } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:47:50.000Z", message: { content: [{ type: "tool_use", id: "toolu_agent1", name: "Agent", input: { description: "Review PR 510", prompt: "Revise a #510", run_in_background: true } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:47:51.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent1", content: "Async agent launched successfully.\nagentId: a0abc123 (internal ID)" }] }, toolUseResult: { status: "async_launched", agentId: "a0abc123" } }),
    // O que o Claude Code também grava e NÃO é a conversa: cópias da requisição sem timestamp nem
    // `toolUseResult`. Não podem tomar o lugar da chamada/resultado de verdade.
    line({ type: "api-request-blob", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash1", name: "Bash", input: { command: "gh pr list" } }] } }),
    line({ type: "api-request-blob", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bash1", content: "#510 a\n#511 b\n" }] } }),
    // Comandos em segundo plano: o resultado só diz para onde a saída vai; a saída real está no arquivo.
    line({ type: "assistant", timestamp: "2026-10-19T20:50:00.000Z", message: { content: [{ type: "tool_use", id: "toolu_bg1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:50:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg1", content: `Command running in background with ID: bgtask01. Output is being written to: ${BG_DIR()}/bgtask01.output. You will be notified when it completes.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bgtask01" } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:51:00.000Z", message: { content: [{ type: "tool_use", id: "toolu_bg2", name: "Bash", input: { command: "npm test", run_in_background: true } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:51:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg2", content: `Command running in background with ID: bgtask02. Output is being written to: ${BG_DIR()}/bgtask02.output. You will be notified when it completes.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bgtask02" } }),
    line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-19T20:53:00.000Z", content: "<task-notification>\n<task-id>bgtask02</task-id>\n<tool-use-id>toolu_bg2</tool-use-id>\n<status>completed</status>\n</task-notification>" }),
    line({ type: "assistant", timestamp: "2026-10-19T20:52:00.000Z", message: { content: [{ type: "tool_use", id: "toolu_bg3", name: "Bash", input: { command: "sleep 999", run_in_background: true } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:52:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg3", content: `Command running in background with ID: bgtask03. Output is being written to: ${BG_DIR()}/bgtask03.output.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bgtask03" } }),
  ].join("\n");
  await mkdir(BG_DIR(), { recursive: true });
  await writeFile(join(BG_DIR(), "bgtask01.output"), "subindo\npronto na 5173\n");
  await writeFile(join(BG_DIR(), "bgtask02.output"), "x".repeat(DETAIL_TEXT_MAX + 10) + "FIM\n");
  await writeFile(join(dir, `${SESSION}.jsonl`), main + "\n");
  const sub = join(dir, SESSION, "subagents");
  await mkdir(sub, { recursive: true });
  const agent = [
    line({ type: "user", isSidechain: true, timestamp: "2026-10-19T20:47:53.000Z", message: { role: "user", content: "Revise a #510" } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:47:55.000Z", message: { content: [{ type: "thinking", thinking: "Leio o diff." }, { type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: "/w/a.js" } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:47:56.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read1", content: "1\tconst a = 1;" }] }, toolUseResult: { type: "text", file: { filePath: "/w/a.js", content: "const a = 1;", numLines: 1, startLine: 1, totalLines: 40 } } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:48:10.000Z", message: { content: [{ type: "tool_use", id: "toolu_test1", name: "Bash", input: { command: "npx jest" } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:48:14.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_test1", is_error: true, content: "Cannot find module 'x'\nstack" }] } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:54:31.000Z", message: { content: [{ type: "text", text: "Aprovar com ajustes." }] } }),
  ].join("\n");
  // Subagente em segundo plano: o meta diz qual chamada o disparou.
  await writeFile(join(sub, "agent-a0abc123.jsonl"), agent + "\n");
  await writeFile(join(sub, "agent-a0abc123.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Review PR 510", toolUseId: "toolu_agent1" }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const probe = (js: string, id: string): string => execFileSync("node", ["-e", js, dir, id]).toString();

describe("detalhe de uma ação, lido do transcript", () => {
  it("do principal: input, saída, raciocínio de antes e quando aconteceu", () => {
    const d = parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bash1"));
    expect(d).toMatchObject({
      found: true, by: "main", name: "Bash", input: { command: "gh pr list" }, isError: false,
      text: "#510 a\n#511 b\n", thinking: "Primeiro a lista das PRs.", result: { lines: 2 },
      startedAt: Date.parse("2026-10-19T20:41:06.000Z"), endedAt: Date.parse("2026-10-19T20:41:07.000Z"),
    });
  });

  it("de um subagente: diz de quem é", () => {
    const d = parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_test1"));
    expect(d).toMatchObject({ found: true, by: "subagent", agentId: "a0abc123", agentDescription: "Review PR 510", isError: true, result: { isError: true, error: "Cannot find module 'x'" } });
  });

  it("id que não existe: não achou", () => {
    expect(parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_nope99"))).toEqual({ found: false });
  });

  it("id torto nunca vira comando", () => {
    expect(() => buildDetailProbeScript("c", dir, "../../etc", "tool")).toThrow(InvalidDetailIdError);
    expect(() => buildDetailProbeScript("c", dir, "a'; rm -rf /", "agent")).toThrow(InvalidDetailIdError);
    expect(buildDetailProbeScript("runner", "/root/x", "toolu_ok123", "tool")).toMatch(/^docker exec 'runner' node -e /);
  });

  it("cópia da requisição no transcript não apaga o horário nem a saída estruturada", () => {
    const d = parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bash1"));
    expect(d.structured).toMatchObject({ stdout: "#510 a\n#511 b\n" });
    expect(d.startedAt).toBe(Date.parse("2026-10-19T20:41:06.000Z"));
    expect(d.endedAt).toBe(Date.parse("2026-10-19T20:41:07.000Z"));
  });

  it("comando em segundo plano: a saída real vem do arquivo e acompanha enquanto roda", async () => {
    const d = parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bg1"));
    expect(d.background).toEqual({ taskId: "bgtask01", status: "running", output: "subindo\npronto na 5173\n", outputLength: 23 });
    await appendFile(join(BG_DIR(), "bgtask01.output"), "GET / 200\n");
    expect(parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bg1")).background?.output).toBe("subindo\npronto na 5173\nGET / 200\n");
  });

  it("comando em segundo plano já terminado: status da notificação e o FIM da saída quando é grande", () => {
    const bg = parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bg2")).background;
    expect(bg?.status).toBe("completed");
    expect(bg?.outputLength).toBe(DETAIL_TEXT_MAX + 14);
    expect(bg?.output?.length).toBe(DETAIL_TEXT_MAX);
    expect(bg?.output?.endsWith("FIM\n")).toBe(true);
  });

  it("comando em segundo plano sem o arquivo de saída: diz que sumiu, não inventa vazio", () => {
    expect(parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bg3")).background).toEqual({ taskId: "bgtask03", status: "running", missing: true });
  });

  it("comando comum não tem segundo plano", () => {
    expect(parseToolDetail(probe(TOOL_DETAIL_PROBE_JS, "toolu_bash1")).background).toBeUndefined();
  });

  it("saída torta vira não achou", () => {
    expect(parseToolDetail("lixo")).toEqual({ found: false });
    expect(parseAgentTimeline("")).toEqual({ found: false, items: [] });
  });
});

describe("linha do tempo de um subagente", () => {
  it("achado pelo meta: tarefa, raciocínio, ações com resultado resumido, texto final", () => {
    const tl = parseAgentTimeline(probe(AGENT_TIMELINE_PROBE_JS, "toolu_agent1"));
    expect(tl).toMatchObject({ found: true, agentId: "a0abc123", description: "Review PR 510", agentType: "general-purpose", prompt: "Revise a #510", toolCount: 2 });
    expect(tl.items.map((i) => i.kind)).toEqual(["thinking", "tool", "tool", "text"]);
    expect(tl.items[1]).toMatchObject({ kind: "tool", id: "toolu_read1", name: "Read", result: { lines: 1, startLine: 1, totalLines: 40 } });
    expect(tl.items[2]).toMatchObject({ kind: "tool", result: { isError: true, error: "Cannot find module 'x'" } });
  });

  it("sem meta com o id: achado pelo agentId que o resultado da chamada traz", async () => {
    await writeFile(join(dir, SESSION, "subagents", "agent-a0abc123.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
    const tl = parseAgentTimeline(probe(AGENT_TIMELINE_PROBE_JS, "toolu_agent1"));
    expect(tl.found).toBe(true);
    expect(tl.agentId).toBe("a0abc123");
  });

  it("chamada sem subagente: não achou", () => {
    expect(parseAgentTimeline(probe(AGENT_TIMELINE_PROBE_JS, "toolu_bash1")).found).toBe(false);
  });
});

describe("pedido de detalhe pelo socket", () => {
  it("só `type: detail` com um pedido conhecido", () => {
    expect(parseDetailFrame(JSON.stringify({ type: "detail", req: "tool", id: "toolu_1", nonce: "n1" }))).toEqual({ req: "tool", id: "toolu_1", path: "", nonce: "n1" });
    expect(parseDetailFrame(JSON.stringify({ type: "detail", req: "rm" }))).toBeNull();
    expect(parseDetailFrame(JSON.stringify({ type: "user", text: "oi" }))).toBeNull();
    expect(parseDetailFrame("oi")).toBeNull();
  });

  it("um por vez por aba; da fila fica só o mais recente de cada pedido", async () => {
    const sent: string[] = [];
    const socket = { readyState: 1, send: (s: string) => { sent.push(s); } } as never;
    const answered: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const respond = createDetailResponder({ cardId: "c", label: "c" }, socket, async (req) => {
      answered.push(`${req.req}:${req.id}:${req.nonce}`);
      if (answered.length === 1) await gate;
      return { type: "detail", req: req.req, id: req.id, nonce: req.nonce };
    });
    respond({ req: "agent", id: "a1", path: "", nonce: "1" });
    respond({ req: "agent", id: "a1", path: "", nonce: "2" });
    respond({ req: "agent", id: "a1", path: "", nonce: "3" });
    respond({ req: "tool", id: "t1", path: "", nonce: "4" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toEqual(["agent:a1:1", "agent:a1:3", "tool:t1:4"]);
    expect(sent).toHaveLength(3);
  });
});

describe("diff de um arquivo do card", () => {
  it("caminho relativo e limpo, ou nada", () => {
    expect(assertWorktreeRelativePath("front/src/a b.tsx")).toBe("front/src/a b.tsx");
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "-rf", "a;b", "", "a`b`"]) {
      expect(() => assertWorktreeRelativePath(bad)).toThrow();
    }
  });

  it("o script compara o worktree com o merge-base, e arquivo novo contra o vazio", () => {
    const script = buildFileDiffScript("runner", "/work/r-worktrees/x", "dev", "src/a.ts");
    expect(script).toContain('git merge-base HEAD "$B"');
    expect(script).toContain("git diff --no-color --no-ext-diff \"$MB\" -- 'src/a.ts'");
    expect(script).toContain("--no-index -- /dev/null 'src/a.ts'");
  });
});

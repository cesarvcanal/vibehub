import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TIMELINE_PROBE_JS,
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vh-detail-"));
  const main = [
    line({ type: "user", timestamp: "2026-10-19T20:41:00.000Z", message: { role: "user", content: "revisa as PRs" } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:41:05.000Z", message: { content: [{ type: "thinking", thinking: "Primeiro a lista das PRs." }] } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:41:06.000Z", message: { content: [{ type: "tool_use", id: "toolu_bash1", name: "Bash", input: { command: "gh pr list", description: "Lista as PRs" } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:41:07.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash1", content: "#510 a\n#511 b\n" }] }, toolUseResult: { stdout: "#510 a\n#511 b\n", stderr: "", interrupted: false } }),
    line({ type: "assistant", timestamp: "2026-10-19T20:47:50.000Z", message: { content: [{ type: "tool_use", id: "toolu_agent1", name: "Agent", input: { description: "Review PR 510", prompt: "Revise a #510", run_in_background: true } }] } }),
    line({ type: "user", timestamp: "2026-10-19T20:47:51.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent1", content: "Async agent launched successfully.\nagentId: a0abc123 (internal ID)" }] }, toolUseResult: { status: "async_launched", agentId: "a0abc123" } }),
  ].join("\n");
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

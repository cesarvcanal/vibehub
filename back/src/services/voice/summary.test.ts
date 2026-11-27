import { describe, it, expect, vi } from "vitest";
import type { HistoryEvent } from "../sdk/history.js";
import { SUMMARY_MAX_CHARS, SUMMARY_MODEL, summarizeConversation } from "./summary.js";

const KEY = "sk-test-summary-key";

function modelAnswer(text: string, status = 200): Response {
  const body = { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }] };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const conversation: HistoryEvent[] = [
  { type: "user", text: "corrige o teste do login", at: 1 },
  { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" }, at: 2 } as HistoryEvent,
  { type: "assistant_text", text: "Corrigido, 12 testes verdes. Falta o merge.", at: 3 } as HistoryEvent,
  { type: "voice_turn", vid: "turn-1", role: "user", text: "e o deploy?", at: 4 },
];

function summarize(cardId: string, events: HistoryEvent[], fetchImpl: typeof fetch, signal?: AbortSignal) {
  return summarizeConversation({ cardId, events, apiKey: KEY, fetchImpl, signal });
}

describe("summarizeConversation", () => {
  it("manda só a conversa ao modelo — nunca ferramentas — e devolve o resumo dele", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("O card corrige o login; testes verdes; falta o merge."));
    expect(await summarize("card-a", conversation, fetchImpl)).toBe("O card corrige o login; testes verdes; falta o merge.");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(SUMMARY_MODEL);
    expect(body.store).toBe(false);
    expect(body.input).toContain("Pessoa (digitou): corrige o teste do login");
    expect(body.input).toContain("Agente do card (Claude): Corrigido, 12 testes verdes. Falta o merge.");
    expect(body.input).toContain("Pessoa (falou): e o deploy?");
    expect(body.input).not.toContain(".env");
  });

  it("a mesma conversa não é resumida duas vezes; uma mensagem nova pede outro resumo", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("resumo"));
    await summarize("card-b", conversation, fetchImpl);
    await summarize("card-b", conversation, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await summarize("card-b", [...conversation, { type: "user", text: "e agora?", at: 5 }], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uma conversa sem nada dito não chama a OpenAI", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("nunca"));
    expect(await summarize("card-c", [conversation[1]!], fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a OpenAI recusa", async () => modelAnswer("x", 500)],
    ["a rede cai", async () => { throw new TypeError("fetch failed"); }],
    ["a resposta não traz texto", async () => new Response(JSON.stringify({ output: [] }), { status: 200 })],
  ])("quando %s, a falha chega a quem pediu e não fica guardada", async (failure, failing) => {
    const fetchImpl = vi.fn(failing);
    await expect(summarize(`card-d ${failure}`, conversation, fetchImpl as typeof fetch)).rejects.toThrow();
    const healthy = vi.fn(async () => modelAnswer("agora sim"));
    expect(await summarize(`card-d ${failure}`, conversation, healthy)).toBe("agora sim");
  });

  it("a recusa da OpenAI diz o código do erro dela, sem o corpo da resposta", async () => {
    const refusal = { error: { message: "Invalid body: failed to parse JSON value.", type: "invalid_request_error", param: null, code: "invalid_json" } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(refusal), { status: 400, headers: { "content-type": "application/json" } }));
    const failure = summarize("card-g", conversation, fetchImpl).catch((err: Error) => err.message);
    expect(await failure).toBe("OpenAI refused the conversation summary (HTTP 400, invalid_json)");
  });

  it("uma mensagem cortada no meio de um emoji ainda sai como Unicode válido para a OpenAI", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("resumo"));
    const emojiAtTheCut = `${"a".repeat(3_998)}😀 fim`;
    await summarize("card-h", [{ type: "user", text: emojiAtTheCut, at: 1 }], fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).input.isWellFormed()).toBe(true);
  });

  it("a chamada desistida (aba fechada) cancela o pedido à OpenAI", async () => {
    const gone = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = summarize("card-e", conversation, fetchImpl as typeof fetch, gone.signal);
    gone.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("um resumo maior que o teto é cortado", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("y".repeat(SUMMARY_MAX_CHARS * 2)));
    const summary = await summarize("card-f", conversation, fetchImpl);
    expect(summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(summary!.endsWith("…")).toBe(true);
  });

  it("numa conversa enorme manda as mensagens mais novas", async () => {
    const fetchImpl = vi.fn(async () => modelAnswer("resumo"));
    const long: HistoryEvent[] = Array.from({ length: 200 }, (_, i) => ({ type: "user", text: `mensagem ${i} ${"z".repeat(1_000)}`, at: i + 1 }));
    await summarize("card-g", long, fetchImpl);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.input).toContain("mensagem 199");
    expect(body.input).not.toContain("mensagem 0 ");
  });
});

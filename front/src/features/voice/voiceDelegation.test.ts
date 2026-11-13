import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceTurn } from "./voiceTurns";
import { DELEGATION_TRANSCRIPT_MAX_CHARS, delegationReply, delegationRequest } from "./voiceDelegation";

const turn = (role: VoiceTurn["role"], text: string, n: number): VoiceTurn => ({ vid: `vc-${role}${n}`, role, text, at: n, final: true });
const user = (id: string, text: string): SdkRow => ({ kind: "user", id, text, state: "sent" });
const answer = (id: string, text: string, extra: Partial<Extract<SdkRow, { kind: "assistant" }>> = {}): SdkRow => ({
  kind: "assistant", id, text, streaming: false, ...extra,
});

describe("delegationRequest", () => {
  it("asks the agent what the person said last, with the call around it", () => {
    const request = delegationRequest([
      turn("user", "oi, tudo bem?", 1),
      turn("assistant", "Tudo, e você?", 2),
      turn("user", "recapitula tudo que tem no chat", 3),
      turn("assistant", "Claro, deixa eu recapitular rapidinho...", 4),
    ])!;
    expect(request.startsWith("[pedido por voz]\nrecapitula tudo que tem no chat\n")).toBe(true);
    expect(request).toContain("Pessoa: oi, tudo bem?");
    expect(request).toContain("Voz: Claro, deixa eu recapitular rapidinho...");
    expect(request.indexOf("oi, tudo bem?")).toBeLessThan(request.indexOf("Voz: Claro"));
  });

  it("keeps the newest of a long call, and nothing when the person said nothing", () => {
    const long = Array.from({ length: 60 }, (_, i) => turn(i % 2 ? "assistant" : "user", `frase ${i} ${"x".repeat(80)}`, i));
    const request = delegationRequest(long)!;
    expect(request).toContain("frase 59");
    expect(request).not.toContain("frase 0 ");
    expect(request.length).toBeLessThan(DELEGATION_TRANSCRIPT_MAX_CHARS + 400);
    expect(delegationRequest([turn("assistant", "Olá!", 1)])).toBeNull();
    expect(delegationRequest([turn("user", "   ", 1)])).toBeNull();
  });
});

describe("delegationReply", () => {
  const request = "[pedido por voz]\nroda os testes";

  it("waits until the request is in the chat and the agent's turn on it is over", () => {
    expect(delegationReply([], request, false)).toEqual({ state: "waiting" });
    const rows = [user("u1", request), answer("a1", "Rodando…")];
    expect(delegationReply(rows, request, true)).toEqual({ state: "waiting" });
  });

  it("answers with the agent's LAST word on it — not a subagent's, not one still streaming, not the next request's", () => {
    const rows = [
      user("u0", "mensagem antiga"),
      answer("a0", "resposta antiga"),
      user("u1", request),
      answer("a1", "Vou rodar."),
      answer("s1", "subagente falando", { parent: "tool_1" }),
      answer("a2", "12 testes verdes."),
      user("u2", "outra coisa"),
      answer("a3", "Resposta da outra coisa", { streaming: true }),
    ];
    // The next message started: the request's turn is over even with a turn running.
    expect(delegationReply(rows, request, true)).toEqual({ state: "answered", text: "12 testes verdes.", answers: ["Vou rodar.", "12 testes verdes."] });
  });

  it("a turn that ends with nothing said is told as such", () => {
    expect(delegationReply([user("u1", request)], request, false)).toEqual({ state: "silent", answers: [] });
  });
});

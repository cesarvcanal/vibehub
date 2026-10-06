import { afterEach, describe, it, expect, vi } from "vitest";
import {
  PEER_TYPING_TTL_MS,
  TYPING_IDLE_MS,
  TYPING_SEND_EVERY_MS,
  applyPeerTyping,
  createTypingSignal,
  nextPeerExpiry,
  typingNames,
} from "./peerTyping";

/**
 * "Cesar está digitando…" — quem está escrevendo NESTE card, visto de outra aba. Dois lados:
 * o que chega (o mapa de quem digita, que expira sozinho) e o que sai (o sinal desta aba,
 * econômico de propósito: um frame a cada poucos segundos, nunca um por tecla).
 */

describe("applyPeerTyping / typingNames — quem está digitando agora", () => {
  it("guarda quem começou e solta quem parou", () => {
    let peers = applyPeerTyping({}, "cesar", true, 1_000);
    expect(typingNames(peers, 1_000, "mussa")).toEqual(["cesar"]);
    peers = applyPeerTyping(peers, "cesar", false, 1_500);
    expect(typingNames(peers, 1_500, "mussa")).toEqual([]);
  });

  it("EXPIRA sozinho: um \"parou\" perdido (aba morta, rede caída) não deixa o indicador para sempre", () => {
    const peers = applyPeerTyping({}, "cesar", true, 1_000);
    expect(typingNames(peers, 1_000 + PEER_TYPING_TTL_MS - 1, "mussa")).toEqual(["cesar"]);
    expect(typingNames(peers, 1_000 + PEER_TYPING_TTL_MS, "mussa")).toEqual([]);
  });

  it("cada novo \"digitando\" renova o prazo", () => {
    let peers = applyPeerTyping({}, "cesar", true, 1_000);
    peers = applyPeerTyping(peers, "cesar", true, 5_000);
    expect(typingNames(peers, 1_000 + PEER_TYPING_TTL_MS + 100, "mussa")).toEqual(["cesar"]);
  });

  it("a própria pessoa nunca se vê digitando (a mesma conta em duas abas)", () => {
    const peers = applyPeerTyping({}, "mussa", true, 1_000);
    expect(typingNames(peers, 1_000, "mussa")).toEqual([]);
  });

  it("várias pessoas: em ordem estável, por nome", () => {
    let peers = applyPeerTyping({}, "rafa", true, 1_000);
    peers = applyPeerTyping(peers, "cesar", true, 1_000);
    expect(typingNames(peers, 1_000, "mussa")).toEqual(["cesar", "rafa"]);
  });

  it("não cria estado novo quando nada muda (um \"parou\" de quem não estava digitando)", () => {
    const peers = applyPeerTyping({}, "cesar", true, 1_000);
    expect(applyPeerTyping(peers, "rafa", false, 1_000)).toBe(peers);
  });
});

describe("createTypingSignal — o que esta aba diz para as outras", () => {
  // restaura os timers mesmo quando uma asserção falha no meio — senão eles vazam para o próximo teste
  afterEach(() => { vi.useRealTimers(); });

  function harness() {
    vi.useFakeTimers();
    const sent: boolean[] = [];
    const signal = createTypingSignal((active) => sent.push(active));
    return { sent, signal };
  }

  it("a primeira tecla avisa na hora; as seguintes, só a cada intervalo (sem sobrecarregar)", () => {
    const { sent, signal } = harness();
    signal.input("o");
    signal.input("oi");
    signal.input("oi ");
    expect(sent).toEqual([true]);
    vi.advanceTimersByTime(TYPING_SEND_EVERY_MS);
    signal.input("oi c");
    expect(sent).toEqual([true, true]);
  });

  it("parou de digitar por um tempo ⇒ avisa que parou", () => {
    const { sent, signal } = harness();
    signal.input("oi");
    vi.advanceTimersByTime(TYPING_IDLE_MS);
    expect(sent).toEqual([true, false]);
  });

  it("cada tecla adia o \"parou\"", () => {
    const { sent, signal } = harness();
    signal.input("o");
    vi.advanceTimersByTime(TYPING_IDLE_MS - 100);
    signal.input("oi");
    vi.advanceTimersByTime(TYPING_IDLE_MS - 100);
    // passou do intervalo, então um "digitando" de renovação saiu — mas NENHUM "parou"
    expect(sent).not.toContain(false);
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toBe(false);
  });

  it("apagou tudo ⇒ parou na hora", () => {
    const { sent, signal } = harness();
    signal.input("oi");
    signal.input("");
    expect(sent).toEqual([true, false]);
  });

  it("stop() (enviou, saiu do card) avisa uma vez só — e nada quando não estava digitando", () => {
    const { sent, signal } = harness();
    signal.stop();
    expect(sent).toEqual([]);
    signal.input("oi");
    signal.stop();
    signal.stop();
    vi.advanceTimersByTime(TYPING_IDLE_MS * 2);
    expect(sent).toEqual([true, false]);
  });

  it("um envio que falha (socket fechado) não derruba quem digita", () => {
    vi.useFakeTimers();
    const signal = createTypingSignal(() => {
      throw new Error("offline");
    });
    expect(() => signal.input("oi")).not.toThrow();
    expect(() => signal.stop()).not.toThrow();
  });
});

describe("nextPeerExpiry — quando a tela precisa olhar de novo", () => {
  it("o vencimento mais próximo ainda à frente; nenhum quando ninguém digita", () => {
    expect(nextPeerExpiry({}, 1_000)).toBe(null);
    const peers = { cesar: 7_000, rafa: 4_000, velho: 500 };
    expect(nextPeerExpiry(peers, 1_000)).toBe(4_000);
  });
});

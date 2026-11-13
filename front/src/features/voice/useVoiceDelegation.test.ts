import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { LiveVoiceSession, type DelegationListener, type LiveVoiceSnapshot } from "./liveVoice";
import { useVoiceDelegation, type UseVoiceDelegationOptions } from "./useVoiceDelegation";
import { DELEGATION_NOT_SENT, DELEGATION_STARTED, DELEGATION_UNHEARD } from "./voiceDelegation";
import type { VoiceTurn } from "./voiceTurns";

/**
 * The failure paths of a delegation, at the hook: whatever happens to the request, the voice gets
 * exactly one result for it. The call is a stand-in for useVoiceCall's (the session behind it is
 * covered in liveVoice.test.ts); the chat is its rows and its send.
 */

const said = (text: string): VoiceTurn[] => [{ vid: "vc-u1", role: "user", text, at: 1, final: true }];

function setup(sendToAgent: (text: string) => void) {
  let listener: DelegationListener = () => undefined;
  const call = {
    snap: { ...LiveVoiceSession.idleSnapshot, state: "live" } as LiveVoiceSnapshot,
    onDelegation: (l: DelegationListener) => {
      listener = l;
      return () => true;
    },
    answerDelegation: vi.fn(() => true),
    appendContext: vi.fn(() => true),
  };
  const view = renderHook((props: Partial<UseVoiceDelegationOptions>) =>
    useVoiceDelegation({ call, rows: [], turnRunning: false, sendToAgent, ...props }),
  );
  return { call, view, delegate: (id: string, turns: VoiceTurn[]) => act(() => listener(id, turns)) };
}

describe("useVoiceDelegation", () => {
  it("a request that cannot reach the agent is answered as such, at once", () => {
    const { call, delegate } = setup(() => {
      throw new Error("offline");
    });
    delegate("d1", said("roda os testes"));
    expect(call.answerDelegation.mock.calls).toEqual([["d1", DELEGATION_NOT_SENT, "result"]]);
  });

  it("nothing heard means a question back, and nothing goes to the agent", () => {
    const send = vi.fn();
    const { call, delegate } = setup(send);
    delegate("d2", []);
    expect(send).not.toHaveBeenCalled();
    expect(call.answerDelegation.mock.calls).toEqual([["d2", DELEGATION_UNHEARD, "result"]]);
  });

  it("a call that ends with a request pending says nothing more about it", () => {
    const send = vi.fn();
    const { call, view, delegate } = setup(send);
    delegate("d3", said("recapitula"));
    expect(call.answerDelegation.mock.calls).toEqual([["d3", DELEGATION_STARTED, "progress"]]);
    const request = send.mock.calls[0]![0] as string;
    call.snap = { ...call.snap, state: "idle" };
    view.rerender({});
    const rows: SdkRow[] = [
      { kind: "user", id: "u1", text: request, state: "sent" },
      { kind: "assistant", id: "a1", text: "Resumo pronto.", streaming: false },
    ];
    call.snap = { ...call.snap, state: "live" };
    view.rerender({ rows });
    expect(call.answerDelegation).toHaveBeenCalledTimes(1);
  });
});

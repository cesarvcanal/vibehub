import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVoiceCallSignal, type UseVoiceCallSignalOptions } from "./useVoiceCallSignal";

describe("useVoiceCallSignal", () => {
  it("com o socket fechando, o aviso de fim de chamada não derruba a tela e sai de novo quando o socket aceita", () => {
    const closing = vi.fn(() => {
      throw new Error("offline");
    });
    const view = renderHook((props: UseVoiceCallSignalOptions) => useVoiceCallSignal(props), {
      initialProps: { connected: true, callLive: true, sendFrame: closing },
    });
    expect(closing).toHaveBeenCalledWith({ type: "voice_call", active: true });

    const open = vi.fn();
    view.rerender({ connected: true, callLive: true, sendFrame: open });
    expect(open).toHaveBeenCalledWith({ type: "voice_call", active: true });
  });
});

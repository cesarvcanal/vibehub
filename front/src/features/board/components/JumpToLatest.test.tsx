import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFakeAnimationFrames } from "@/test/animationFrames";
import { useStickToBottom } from "./JumpToLatest";

const CLIENT_HEIGHT = 400;

function fakeScroller() {
  return { scrollHeight: 1_000, scrollTop: 0, clientHeight: CLIENT_HEIGHT };
}

function renderSmoothStick(scroller: ReturnType<typeof fakeScroller>) {
  useFakeAnimationFrames();
  const hook = renderHook(({ content }) => useStickToBottom(content, { smooth: true }), { initialProps: { content: 1 } });
  hook.result.current.scrollerRef.current = scroller as unknown as HTMLDivElement;
  hook.rerender({ content: 1 });
  scroller.scrollTop = scroller.scrollHeight - CLIENT_HEIGHT;
  act(() => hook.result.current.onScroll());
  return hook;
}

describe("useStickToBottom com rolagem suave", () => {
  it("com o leitor no fim, conteúdo novo desce animado até o fim, sem pular de uma vez", () => {
    const scroller = fakeScroller();
    const hook = renderSmoothStick(scroller);
    scroller.scrollHeight = 1_300;
    hook.rerender({ content: 2 });
    expect(scroller.scrollTop).toBe(600);
    act(() => { vi.advanceTimersByTime(100); });
    expect(scroller.scrollTop).toBeGreaterThan(600);
    expect(scroller.scrollTop).toBeLessThan(900);
    act(() => { vi.advanceTimersByTime(600); });
    expect(scroller.scrollTop).toBe(900);
  });

  it("a descida animada ainda longe do fim não solta o leitor do fim", () => {
    const scroller = fakeScroller();
    const hook = renderSmoothStick(scroller);
    scroller.scrollHeight = 2_000;
    hook.rerender({ content: 2 });
    act(() => { vi.advanceTimersByTime(50); });
    act(() => hook.result.current.onScroll());
    expect(scroller.scrollHeight - scroller.scrollTop - CLIENT_HEIGHT).toBeGreaterThan(120);
    expect(hook.result.current.atBottom).toBe(true);
    act(() => { vi.advanceTimersByTime(700); });
    expect(scroller.scrollTop).toBe(1_600);
  });

  it("quem rolou para cima fica onde está: conteúdo novo não desce e marca que chegou mensagem", () => {
    const scroller = fakeScroller();
    const hook = renderSmoothStick(scroller);
    scroller.scrollTop = 100;
    act(() => hook.result.current.onScroll());
    scroller.scrollHeight = 1_300;
    hook.rerender({ content: 2 });
    act(() => { vi.advanceTimersByTime(700); });
    expect(scroller.scrollTop).toBe(100);
    expect(hook.result.current.atBottom).toBe(false);
    expect(hook.result.current.newSince).toBe(true);
  });

  it("rolar para cima no meio da descida para a animação ali", () => {
    const scroller = fakeScroller();
    const hook = renderSmoothStick(scroller);
    scroller.scrollHeight = 2_000;
    hook.rerender({ content: 2 });
    act(() => { vi.advanceTimersByTime(50); });
    act(() => hook.result.current.onScroll());
    scroller.scrollTop -= 200;
    act(() => hook.result.current.onScroll());
    const stoppedAt = scroller.scrollTop;
    act(() => { vi.advanceTimersByTime(700); });
    expect(scroller.scrollTop).toBe(stoppedAt);
  });
});

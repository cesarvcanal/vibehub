import { describe, expect, it, onTestFinished, vi } from "vitest";
import { animateScrollToBottom } from "./animateScrollToBottom";

function fakeScroller(scrollTop: number, scrollHeight: number) {
  return { scrollTop, scrollHeight, clientHeight: 400 };
}

function glideToBottom(scroller: ReturnType<typeof fakeScroller>, onArrive: () => void = () => undefined) {
  return animateScrollToBottom(scroller as unknown as HTMLElement, onArrive);
}

function useFakeFrames() {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  onTestFinished(() => { vi.useRealTimers(); });
}

describe("animateScrollToBottom", () => {
  it("desce até o fim em no máximo 600 ms, devagar no final, e avisa quando chega", () => {
    useFakeFrames();
    const scroller = fakeScroller(0, 1_000);
    const onArrive = vi.fn();
    glideToBottom(scroller, onArrive);
    vi.advanceTimersByTime(150);
    const halfway = scroller.scrollTop;
    expect(halfway).toBeGreaterThan(300);
    expect(halfway).toBeLessThan(600);
    expect(onArrive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(scroller.scrollTop).toBe(600);
    expect(onArrive).toHaveBeenCalledOnce();
  });

  it("já no fim, não anima nada", () => {
    expect(glideToBottom(fakeScroller(600, 1_000))).toBeNull();
  });

  it("conteúdo que chega no meio da descida empurra o destino, sem recomeçar", () => {
    useFakeFrames();
    const scroller = fakeScroller(0, 700);
    glideToBottom(scroller);
    vi.advanceTimersByTime(100);
    scroller.scrollHeight = 900;
    vi.advanceTimersByTime(600);
    expect(scroller.scrollTop).toBe(500);
  });

  it("distância maior que 800 px salta para 800 px do fim e anima só esse trecho", () => {
    useFakeFrames();
    const scroller = fakeScroller(0, 5_000);
    glideToBottom(scroller);
    expect(scroller.scrollTop).toBe(3_800);
    vi.advanceTimersByTime(650);
    expect(scroller.scrollTop).toBe(4_600);
  });

  it("quadro com carimbo de tempo anterior ao início não sobe a rolagem", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) => frames.push(step));
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const scroller = fakeScroller(18, 546);
    glideToBottom(scroller);
    frames[0]!(performance.now() - 16);
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(18);
  });

  it("cancelada, para onde está e não avisa chegada", () => {
    useFakeFrames();
    const scroller = fakeScroller(0, 1_000);
    const onArrive = vi.fn();
    const cancel = glideToBottom(scroller, onArrive);
    vi.advanceTimersByTime(50);
    cancel!();
    const stoppedAt = scroller.scrollTop;
    vi.advanceTimersByTime(600);
    expect(scroller.scrollTop).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan(600);
    expect(onArrive).not.toHaveBeenCalled();
  });
});

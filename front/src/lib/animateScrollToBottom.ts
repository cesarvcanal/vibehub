// external: duração, curva e salto copiados do Telegram Web A (Ajaxy/telegram-tt, src/util/animateScroll.ts e config.ts SCROLL_*)
const SCROLL_MIN_DURATION_MS = 300;
const SCROLL_MAX_DURATION_MS = 600;
const SCROLL_MAX_DISTANCE_PX = 800;
const SHORT_SCROLL_PX = 300;

const easeShortScroll = (progress: number) => 1 - (1 - progress) ** 3.5;
const easeLongScroll = (progress: number) => 1 - (1 - progress) ** 6;

export function animateScrollToBottom(scroller: HTMLElement, onArrive: () => void): (() => void) | null {
  const bottomOf = () => scroller.scrollHeight - scroller.clientHeight;
  const distance = bottomOf() - scroller.scrollTop;
  if (distance <= 0) return null;
  if (distance > SCROLL_MAX_DISTANCE_PX) scroller.scrollTop = bottomOf() - SCROLL_MAX_DISTANCE_PX;
  const startTop = scroller.scrollTop;
  const travel = Math.min(distance, SCROLL_MAX_DISTANCE_PX);
  const duration = SCROLL_MIN_DURATION_MS + (travel / SCROLL_MAX_DISTANCE_PX) * (SCROLL_MAX_DURATION_MS - SCROLL_MIN_DURATION_MS);
  const ease = travel > SHORT_SCROLL_PX ? easeLongScroll : easeShortScroll;
  const startedAt = performance.now();
  const frame = { id: 0 };
  const step = (now: number) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
    scroller.scrollTop = startTop + (bottomOf() - startTop) * ease(progress);
    if (progress < 1) frame.id = requestAnimationFrame(step);
    else onArrive();
  };
  frame.id = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame.id);
}

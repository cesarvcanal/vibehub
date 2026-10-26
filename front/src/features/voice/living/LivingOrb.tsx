import * as React from "react";
import { cn } from "@/lib/utils";
import { LivingEngine, type LivingMode, type LivingSettings } from "./engine";

/**
 * The approved V37 "living intelligence" on a canvas: pink/lilac sphere while listening, blue while
 * the assistant replies, the three-ribbon Multiverso mark otherwise.
 *
 * Levels arrive as props but are read through refs inside the animation loop, so the 20-per-second
 * level updates never restart anything. The loop, the ResizeObserver and the reduced-motion
 * listener all end on unmount. It never touches a microphone itself: whoever owns the streams
 * measures them and passes the numbers in.
 */
export function LivingOrb({
  mode,
  listenLevel,
  talkLevel,
  settings,
  onEngine,
  className,
}: {
  mode: LivingMode;
  /** 0..1 from the PERSON's microphone (see levels.ts). */
  listenLevel: number;
  /** 0..1 from the ASSISTANT's audio; null when it cannot be measured (a soft envelope stands in). */
  talkLevel: number | null;
  /** Shared, mutable settings (the lab tunes them live); the approved defaults otherwise. */
  settings?: LivingSettings;
  /** The lab drives forced transitions and reads the engine's state. */
  onEngine?: (engine: LivingEngine | null) => void;
  className?: string;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const engineRef = React.useRef<LivingEngine | null>(null);
  const levels = React.useRef({ listen: listenLevel, talk: talkLevel });
  levels.current = { listen: listenLevel, talk: talkLevel };
  const initial = React.useRef({ mode, settings, onEngine });

  React.useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true }) ?? null;
    const { mode: firstMode, settings: shared, onEngine: report } = initial.current;
    const engine = new LivingEngine({ mode: firstMode, settings: shared });
    engineRef.current = engine;
    report?.(engine);
    if (!box || !canvas || !ctx) return () => report?.(null);

    const resize = (): void => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      engine.setSize(r.width, r.height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);

    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reduce = media?.matches ?? false;
    const onMotion = (e: MediaQueryListEvent): void => {
      reduce = e.matches;
    };
    media?.addEventListener?.("change", onMotion);

    let last = 0;
    let frame = 0;
    const render = (time: number): void => {
      frame = requestAnimationFrame(render);
      const dt = last ? (time - last) / 1000 : 0.016;
      last = time;
      engine.step(dt, { listen: levels.current.listen, talk: levels.current.talk, reduce });
      engine.draw(ctx);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      media?.removeEventListener?.("change", onMotion);
      engineRef.current = null;
      report?.(null);
    };
  }, []);

  React.useEffect(() => {
    engineRef.current?.change(mode);
  }, [mode]);

  return (
    <div
      ref={boxRef}
      data-testid="voice-orb"
      data-mode={mode}
      aria-hidden="true"
      className={cn(
        "relative aspect-square overflow-hidden rounded-[2rem]",
        // V37's stage: deep navy with a soft cyan bloom behind the particles.
        "bg-[radial-gradient(ellipse_at_50%_40%,#0b2740_0%,#051423_45%,#020913_78%)]",
        "before:absolute before:inset-[10%] before:rounded-full before:bg-[radial-gradient(circle,#0b47602a_0%,#1b6c920c_55%,transparent_72%)] before:blur-[30px] before:content-['']",
        className,
      )}
    >
      <canvas ref={canvasRef} className="relative block h-full w-full" />
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";
import { LivingEngine, type LivingMode, type LivingSettings } from "./engine";

/**
 * The approved V37 "living intelligence" on a canvas: pink/lilac sphere while listening, blue while
 * the assistant replies, the three-ribbon Multiverso mark otherwise.
 *
 * Levels arrive as props, or — for a live call — as a `levels` function read on EVERY frame, so the
 * orb follows the sound at frame rate without a React render per sample. The loop, the
 * ResizeObserver and the reduced-motion listener all end on unmount. It never touches a microphone
 * itself: whoever owns the streams measures them and passes the numbers in.
 *
 * Any size: the engine always simulates and draws on a stage of at least {@link REFERENCE_PX} and
 * the canvas scales it down — a small orb in the chat is a faithful miniature of the approved one,
 * not 4200 particles crammed into 70 px.
 */

/** The smallest stage the engine draws on (V37's own was ~620 px; 360 keeps every proportion). */
export const REFERENCE_PX = 360;

export interface OrbLevels {
  listen: number;
  talk: number | null;
}
export function LivingOrb({
  mode,
  listenLevel,
  talkLevel,
  levels: readLevels,
  settings,
  onEngine,
  fps,
  stage = "panel",
  className,
}: {
  mode: LivingMode;
  /** 0..1 from the PERSON's microphone (see levels.ts). */
  listenLevel?: number;
  /** 0..1 from the ASSISTANT's audio; null when it cannot be measured (a soft envelope stands in). */
  talkLevel?: number | null;
  /** Read once per frame instead of the two props — the live call's meters. */
  levels?: () => OrbLevels;
  /** Cap on frames per second (a small orb in the chat needs fewer). Default: the display's rate. */
  fps?: number;
  /** `panel`: V37's navy rounded stage. `badge`: a round navy disc, for the orb inside the chat. */
  stage?: "panel" | "badge";
  /** Shared, mutable settings (the lab tunes them live); the approved defaults otherwise. */
  settings?: LivingSettings;
  /** The lab drives forced transitions and reads the engine's state. */
  onEngine?: (engine: LivingEngine | null) => void;
  className?: string;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const engineRef = React.useRef<LivingEngine | null>(null);
  const levels = React.useRef<() => OrbLevels>(() => ({ listen: 0, talk: null }));
  levels.current = readLevels ?? (() => ({ listen: listenLevel ?? 0, talk: talkLevel ?? null }));
  const initial = React.useRef({ mode, settings, onEngine, fps });

  React.useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true }) ?? null;
    const { mode: firstMode, settings: shared, onEngine: report, fps: maxFps } = initial.current;
    const engine = new LivingEngine({ mode: firstMode, settings: shared });
    engineRef.current = engine;
    report?.(engine);
    if (!box || !canvas || !ctx) return () => report?.(null);

    const resize = (): void => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const scale = r.width > 0 && r.width < REFERENCE_PX ? r.width / REFERENCE_PX : 1;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      engine.setSize(r.width / scale, r.height / scale);
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
    const minGap = maxFps ? 1000 / maxFps - 2 : 0;
    const render = (time: number): void => {
      frame = requestAnimationFrame(render);
      if (minGap > 0 && last && time - last >= 0 && time - last < minGap) return;
      const dt = last ? (time - last) / 1000 : 0.016;
      last = time;
      const now = levels.current();
      engine.step(dt, { listen: now.listen, talk: now.talk, reduce });
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
      data-stage={stage}
      className={cn(
        "relative aspect-square overflow-hidden",
        stage === "panel" ? "rounded-[2rem]" : "rounded-full ring-1 ring-sky-300/15",
        // V37's stage: deep navy with a soft cyan bloom behind the particles.
        "bg-[radial-gradient(ellipse_at_50%_40%,#0b2740_0%,#051423_45%,#020913_78%)]",
        "before:absolute before:inset-[10%] before:rounded-full before:bg-[radial-gradient(circle,#0b47602a_0%,#1b6c920c_55%,transparent_72%)] before:content-['']",
        stage === "panel" ? "before:blur-[30px]" : "before:blur-md",
        className,
      )}
    >
      <canvas ref={canvasRef} className="relative block h-full w-full" />
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The voice mode's orb: a soft blue-and-white blob that is always gently alive and swells with
 * sound — the person's microphone while they talk, the assistant's audio while it answers.
 *
 * Drawn by hand on a canvas (no image, no third-party asset): a circle whose radius is nudged by a
 * few slow sine harmonics, filled with radial gradients. The level is read from a ref inside the
 * animation loop, so the 20-per-second level updates never re-render React. With
 * `prefers-reduced-motion` the shape stops flowing and only its size follows the level; without
 * a 2D context (old browser, tests) a CSS gradient stands in.
 */

export type OrbMode = "idle" | "connecting" | "listening" | "speaking" | "muted" | "error";

/** Radius of the blob at angle `theta`, time `t` (s), for a level 0..1. PURE. */
export function orbRadius(base: number, theta: number, t: number, level: number, flowing: boolean): number {
  const swell = 1 + 0.12 * level;
  if (!flowing) return base * swell;
  const wobble =
    Math.sin(theta * 3 + t * 0.9) * 0.018 +
    Math.sin(theta * 5 - t * 1.3) * 0.012 +
    Math.sin(theta * 2 + t * 0.5) * 0.02;
  // Sound makes the edge livelier, not only bigger.
  const excite = Math.sin(theta * 7 + t * 4) * 0.035 * level;
  return base * (swell + wobble + excite);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const POINTS = 96;

export function VoiceOrb({
  level,
  mode,
  size = 240,
  className,
}: {
  /** 0..1 — whatever should drive it right now (mic or assistant). */
  level: number;
  mode: OrbMode;
  size?: number;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const levelRef = React.useRef(level);
  const modeRef = React.useRef(mode);
  const [fallback, setFallback] = React.useState(false);
  levelRef.current = level;
  modeRef.current = mode;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas?.getContext("2d") ?? null;
    } catch {
      ctx = null;
    }
    if (!canvas || !ctx) {
      setFallback(true);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const reduced = prefersReducedMotion();
    let smooth = 0;
    let frame = 0;
    const start = performance.now();

    const draw = (now: number): void => {
      const t = (now - start) / 1000;
      const m = modeRef.current;
      // Ease toward the target so a level jump is a swell, not a flicker.
      const target = m === "muted" || m === "error" || m === "idle" ? 0 : levelRef.current;
      smooth += (target - smooth) * 0.18;
      const c = size / 2;
      const base = size * 0.36;
      ctx!.clearRect(0, 0, size, size);

      // Halo.
      const halo = ctx!.createRadialGradient(c, c, base * 0.6, c, c, base * 1.45);
      halo.addColorStop(0, `rgba(125, 196, 255, ${0.25 + smooth * 0.35})`);
      halo.addColorStop(1, "rgba(125, 196, 255, 0)");
      ctx!.fillStyle = halo;
      ctx!.fillRect(0, 0, size, size);

      // Body.
      ctx!.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const theta = (i / POINTS) * Math.PI * 2;
        const r = orbRadius(base, theta, t, smooth, !reduced && m !== "error");
        const x = c + Math.cos(theta) * r;
        const y = c + Math.sin(theta) * r;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.closePath();
      const drift = reduced ? 0 : Math.sin(t * 0.6) * base * 0.18;
      const body = ctx!.createRadialGradient(c - base * 0.3 + drift, c - base * 0.35, base * 0.05, c, c, base * 1.1);
      const deep = m === "error" ? "rgb(148, 163, 184)" : m === "speaking" ? "rgb(37, 132, 255)" : "rgb(66, 153, 255)";
      body.addColorStop(0, "rgb(255, 255, 255)");
      body.addColorStop(0.35, "rgb(214, 236, 255)");
      body.addColorStop(0.75, "rgb(126, 190, 255)");
      body.addColorStop(1, deep);
      ctx!.fillStyle = body;
      ctx!.globalAlpha = m === "idle" || m === "muted" ? 0.8 : 1;
      ctx!.fill();

      // A slow inner cloud, the "fluid" look.
      if (!reduced) {
        const cx = c + Math.cos(t * 0.7) * base * 0.25;
        const cy = c + Math.sin(t * 0.9) * base * 0.2;
        const cloud = ctx!.createRadialGradient(cx, cy, 0, cx, cy, base * 0.7);
        cloud.addColorStop(0, `rgba(255, 255, 255, ${0.45 + smooth * 0.3})`);
        cloud.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx!.fillStyle = cloud;
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      // Reduced motion: draw only while something is changing.
      if (!reduced || Math.abs(target - smooth) > 0.002) frame = requestAnimationFrame(draw);
      else frame = 0;
    };
    frame = requestAnimationFrame(draw);

    // Reduced motion stops the loop at rest; a new level must wake it.
    const wake = reduced
      ? setInterval(() => {
          if (frame === 0) frame = requestAnimationFrame(draw);
        }, 100)
      : null;
    return () => {
      cancelAnimationFrame(frame);
      if (wake) clearInterval(wake);
    };
  }, [size]);

  return (
    <div
      className={cn("relative flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      data-testid="voice-orb"
      data-mode={mode}
      aria-hidden="true"
    >
      {fallback ? (
        <div
          className="rounded-full bg-[radial-gradient(circle_at_35%_30%,#fff_0%,#d6ecff_35%,#7ebeff_75%,#4299ff_100%)] transition-transform duration-150"
          style={{ width: size * 0.72, height: size * 0.72, transform: `scale(${1 + 0.12 * (mode === "muted" ? 0 : level)})` }}
        />
      ) : (
        <canvas ref={canvasRef} style={{ width: size, height: size }} />
      )}
    </div>
  );
}

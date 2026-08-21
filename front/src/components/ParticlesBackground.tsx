import * as React from "react";

/**
 * The atmosphere behind the whole app: a constellation of blue particles that drift and link up
 * when they get close. It is the same network motif the panel this was extracted from uses, and it
 * reads as "a machine with things moving on it", which is exactly what a board of live agents is.
 *
 * Cheap on purpose — one canvas, no library, capped particle count, cleaned up on unmount. With
 * `prefers-reduced-motion: reduce` it paints a single static frame and never schedules a loop.
 */
export interface ParticlesBackgroundProps {
  /** Position as `fixed` (behind the whole app) instead of `absolute` (inside its container). */
  fixed?: boolean;
  /** Opacity multiplier (0-1). Use < 1 to keep it subtle behind readable content. */
  dim?: number;
}

/** Links are drawn between any two particles closer than this, fading out with distance. */
const LINK_DISTANCE = 140;
const MIN_PARTICLES = 28;
const MAX_PARTICLES = 90;
/** One particle per this many square pixels, between the two bounds above. */
const AREA_PER_PARTICLE = 17000;

export function ParticlesBackground({ fixed = false, dim = 1 }: ParticlesBackgroundProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // no 2d context (jsdom, or a browser that refused one): render nothing

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
    }
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let raf = 0;

    const resize = () => {
      width = fixed ? window.innerWidth : canvas.clientWidth;
      height = fixed ? window.innerHeight : canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(
        MIN_PARTICLES,
        Math.min(MAX_PARTICLES, Math.floor((width * height) / AREA_PER_PARTICLE)),
      );
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
      }));
    };

    /** Advance every particle one frame, bouncing off the edges of the viewport. */
    const step = () => {
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x <= 0 || p.x >= width) p.vx *= -1;
        if (p.y <= 0 || p.y >= height) p.vy *= -1;
      }
    };

    const paint = () => {
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i]!;
          const b = particles[j]!;
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (distance >= LINK_DISTANCE) continue;
          ctx.strokeStyle = `rgba(56,150,230,${(1 - distance / LINK_DISTANCE) * 0.22 * dim})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const p of particles) {
        ctx.fillStyle = `rgba(96,182,255,${0.75 * dim})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      step();
      paint();
      raf = requestAnimationFrame(loop);
    };

    const onResize = () => {
      resize();
      // A static frame has to be repainted by hand, since no loop will come along and do it.
      if (reduce) paint();
    };

    resize();
    window.addEventListener("resize", onResize);
    if (reduce) paint();
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [fixed, dim]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="particles-background"
      // Behind everything: `-z-10` keeps it under in-flow page content, which is not positioned
      // and would otherwise be painted below a plain `fixed` element.
      className={`pointer-events-none inset-0 h-full w-full ${fixed ? "fixed -z-10" : "absolute"}`}
    />
  );
}

export default ParticlesBackground;

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The voice mode's orb: a "living particle" — a luminous white core inside translucent blue
 * layers, with drifting filaments, mist and sparks, wrapped in a faint halo. Always quietly alive,
 * it brightens and quickens with sound: the person's microphone while they talk, the assistant's
 * audio while it answers.
 *
 * Drawn by a small WebGL fragment shader (no image, no third-party asset): domain-warped value
 * noise makes the mist, ridged noise the filaments, a hashed grid the sparks. Everything that moves
 * is driven from a ref inside the animation loop, so the 20-per-second level updates never
 * re-render React. With `prefers-reduced-motion` the inner motion is frozen and only the glow
 * follows the level; without WebGL (old browser, tests, lost context) a layered CSS orb stands in.
 */

export type OrbMode = "idle" | "connecting" | "listening" | "speaking" | "muted" | "error";

type Rgb = readonly [number, number, number];

/** How the orb looks in each mode. PURE — the loop eases toward these. */
export interface OrbLook {
  /** Deep tone of the translucent body. */
  tint: Rgb;
  /** Light tone of the mist, filaments and halo. */
  glow: Rgb;
  /** 0..1 — how fast and turbulent the inside flows. */
  energy: number;
  /** 0..1 — washes the colour out (muted, error). */
  dim: number;
  /** Whether sound may drive it. */
  hears: boolean;
}

const LOOKS: Record<OrbMode, OrbLook> = {
  idle: { tint: [0.2, 0.46, 0.95], glow: [0.66, 0.86, 1], energy: 0.15, dim: 0.1, hears: false },
  connecting: { tint: [0.2, 0.46, 0.95], glow: [0.66, 0.86, 1], energy: 0.45, dim: 0, hears: false },
  listening: { tint: [0.16, 0.5, 1], glow: [0.62, 0.88, 1], energy: 0.4, dim: 0, hears: true },
  speaking: { tint: [0.09, 0.33, 1], glow: [0.72, 0.86, 1], energy: 0.75, dim: 0, hears: true },
  muted: { tint: [0.3, 0.42, 0.62], glow: [0.7, 0.78, 0.88], energy: 0.1, dim: 0.65, hears: false },
  error: { tint: [0.45, 0.47, 0.52], glow: [0.75, 0.77, 0.8], energy: 0.04, dim: 0.85, hears: false },
};

export function orbLook(mode: OrbMode): OrbLook {
  return LOOKS[mode];
}

/**
 * One step of the level follower: quick to rise (a syllable lands at once), slow to fall (the
 * glow lingers instead of flickering). PURE.
 */
export function followLevel(current: number, target: number): number {
  const k = target > current ? 0.35 : 0.07;
  return current + (Math.max(0, Math.min(1, target)) - current) * k;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 uRes;
uniform float uPhase;
uniform float uLevel;
uniform float uEnergy;
uniform float uDim;
uniform vec3 uTint;
uniform vec3 uGlow;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  float r = length(p);
  float t = uPhase;
  float R = 0.6 + 0.06 * uLevel;
  vec2 q = p / R;
  float d = length(q);
  // A sphere seen from the front: depth bends the inner pattern, so it reads as volume.
  float z = sqrt(max(0.0, 1.0 - d * d));
  vec2 s = q / (1.0 + z);

  vec2 w = vec2(fbm(s * 2.4 + vec2(t, -0.7 * t)), fbm(s * 2.4 + vec2(-0.6 * t, t) + 5.2));
  float mist = fbm(s * 3.0 + 2.4 * w + 0.15 * t);
  float ridge = 1.0 - abs(2.0 * fbm(s * 4.2 + 1.8 * w - 0.4 * t) - 1.0);
  float filament = pow(ridge, 7.0) * (0.55 + 0.9 * uLevel + 0.3 * uEnergy);

  float body = smoothstep(1.0, 0.9, d);
  float core = exp(-d * d * (4.2 - 1.8 * uLevel));
  float rim = pow(1.0 - z, 2.5) * body;
  // The halo fades out well before the canvas edge, so no square ever shows.
  float halo = exp(-max(r - R, 0.0) * (8.0 - 3.5 * uLevel)) * (1.0 - body) * smoothstep(1.0, 0.7, r);

  // Sparks: one candidate per cell of a slowly rising grid, twinkling, inside the body only.
  vec2 g = s * 11.0 + vec2(0.3 * t, 0.8 * t);
  vec2 id = floor(g);
  vec2 jitter = vec2(hash(id), hash(id + 7.1));
  float twinkle = 0.5 + 0.5 * sin(6.2831 * hash(id + 3.3) + 4.0 * t);
  float spark = smoothstep(0.09, 0.0, length(fract(g) - jitter)) * step(0.72, hash(id + 1.9)) * twinkle;
  spark *= body * (0.35 + 0.8 * uLevel);

  vec3 col = uTint * body * (0.3 + 0.35 * mist)
           + uGlow * body * mist * mist * 0.9
           + uGlow * filament * body
           + uGlow * rim * 0.75
           + vec3(1.0) * core * (0.7 + 0.3 * uLevel)
           + uGlow * halo * (0.28 + 0.45 * uLevel)
           + vec3(1.0) * spark;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), uDim) * (1.0 - 0.35 * uDim);

  // The halo is pure light (its opacity is its brightness), so it never greys a light page.
  float a = body * (0.45 + 0.35 * mist + 0.2 * core);
  a = clamp(max(a, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(a)), a);
}
`;

interface Renderer {
  draw(u: { phase: number; level: number; energy: number; dim: number; tint: Rgb; glow: Rgb }): void;
  dispose(): void;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** The shader on a full-canvas quad, or null when this browser can't run it. */
function makeRenderer(canvas: HTMLCanvasElement): Renderer | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const loc = (n: string) => gl!.getUniformLocation(prog, n);
  const uRes = loc("uRes"), uPhase = loc("uPhase"), uLevel = loc("uLevel"), uEnergy = loc("uEnergy");
  const uDim = loc("uDim"), uTint = loc("uTint"), uGlow = loc("uGlow");

  return {
    draw(u) {
      const g = gl!;
      g.viewport(0, 0, canvas.width, canvas.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.uniform2f(uRes, canvas.width, canvas.height);
      g.uniform1f(uPhase, u.phase);
      g.uniform1f(uLevel, u.level);
      g.uniform1f(uEnergy, u.energy);
      g.uniform1f(uDim, u.dim);
      g.uniform3f(uTint, u.tint[0], u.tint[1], u.tint[2]);
      g.uniform3f(uGlow, u.glow[0], u.glow[1], u.glow[2]);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl!.deleteBuffer(buf);
      gl!.deleteProgram(prog);
      gl!.deleteShader(vs);
      gl!.deleteShader(fs);
    },
  };
}

const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

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
    const renderer = canvas ? makeRenderer(canvas) : null;
    if (!canvas || !renderer) {
      setFallback(true);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const reduced = prefersReducedMotion();
    const start = LOOKS[modeRef.current];
    const s = { level: 0, energy: start.energy, dim: start.dim, tint: start.tint, glow: start.glow };
    // Reduced motion: the inside stands still at a pleasant spot; only the glow follows sound.
    let phase = reduced ? 3.7 : 0;
    let last = performance.now();
    let frame = 0;

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = modeRef.current;
      const look = LOOKS[m];
      // Connecting breathes on its own while it waits.
      const target = look.hears ? levelRef.current : m === "connecting" && !reduced ? 0.12 + 0.12 * Math.sin(now / 420) : 0;
      const before = s.level;
      s.level = followLevel(s.level, target);
      const k = 0.06;
      s.energy += (look.energy - s.energy) * k;
      s.dim += (look.dim - s.dim) * k;
      s.tint = mixRgb(s.tint, look.tint, k);
      s.glow = mixRgb(s.glow, look.glow, k);
      if (!reduced) phase += dt * (0.08 + 0.3 * s.energy + 0.55 * s.level);
      renderer.draw({ phase, ...s });

      const settling = Math.abs(s.level - before) > 0.001 || Math.abs(look.dim - s.dim) > 0.002;
      frame = !reduced || settling ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);

    // Reduced motion stops the loop at rest; a new level or mode must wake it.
    const wake = reduced
      ? setInterval(() => {
          if (frame === 0) {
            last = performance.now();
            frame = requestAnimationFrame(tick);
          }
        }, 100)
      : null;
    const lost = (e: Event) => {
      e.preventDefault();
      setFallback(true);
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => {
      cancelAnimationFrame(frame);
      if (wake) clearInterval(wake);
      canvas.removeEventListener("webglcontextlost", lost);
      renderer.dispose();
    };
  }, [size]);

  const look = LOOKS[mode];
  const swell = 1 + 0.08 * (look.hears ? level : 0);
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
          data-testid="voice-orb-fallback"
          className={cn("relative rounded-full transition-[transform,filter] duration-200", look.dim > 0.5 && "grayscale")}
          style={{ width: size * 0.62, height: size * 0.62, transform: `scale(${swell})` }}
        >
          <div className="absolute -inset-[18%] rounded-full bg-sky-300/30 blur-2xl" />
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.95)_0%,rgba(186,224,255,0.75)_30%,rgba(59,130,246,0.55)_75%,rgba(37,99,235,0.35)_100%)] shadow-[inset_0_0_30px_rgba(255,255,255,0.6)]" />
          <div className="absolute inset-[12%] rounded-full bg-[conic-gradient(from_0deg,transparent,rgba(255,255,255,0.45),transparent_40%,rgba(147,197,253,0.5),transparent_75%)] opacity-70 blur-md motion-safe:animate-[spin_9s_linear_infinite]" />
        </div>
      ) : (
        <canvas ref={canvasRef} style={{ width: size, height: size }} />
      )}
    </div>
  );
}

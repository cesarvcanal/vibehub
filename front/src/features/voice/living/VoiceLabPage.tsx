import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Paths } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { useMicLevel } from "../micLevel";
import { LivingOrb } from "./LivingOrb";
import {
  STAGE_DEFS,
  TALK_INTENSITY,
  defaultSettings,
  makeSchedule,
  scheduleDuration,
  tuningText,
  type LivingEngine,
  type LivingMode,
  type LivingSettings,
  type ScalarSetting,
} from "./engine";
import { micVoice } from "./levels";

/**
 * `/voice/lab` — the V37 calibration bench, for developers. Not linked anywhere: the voice mode
 * itself stays clean. The same engine and orb as /voice, plus the demo's controls: modes, the
 * way-in/way-back tests, a REAL microphone for listening, a SIMULATED assistant voice for replying
 * (the lab has no conversation), and the tuning panel with "copy parameters".
 */

const SCALARS: { id: ScalarSetting; label: string; min: number; max: number; step: number; unit: string }[] = [
  { id: "thickness", label: "Grossura", min: 50, max: 240, step: 5, unit: "%" },
  { id: "flowSpeed", label: "Fluxo normal", min: 20, max: 350, step: 5, unit: "%" },
  { id: "accelSpeed", label: "Velocidade máxima", min: 35, max: 250, step: 5, unit: "%" },
  { id: "tracking", label: "Arrasto do desenho", min: 0, max: 100, step: 5, unit: "%" },
  { id: "logoEntrySpin", label: "Impulso ao criar logo", min: 0, max: 85, step: 1, unit: "°/s" },
  { id: "logoEntrySpinMs", label: "Duração do giro inicial", min: 150, max: 1400, step: 10, unit: " ms" },
  { id: "listenSpin", label: "Giro Escutando ↺", min: 0, max: 25, step: 1, unit: "°/s" },
  { id: "talkSpin", label: "Giro Respondendo ↻", min: 0, max: 25, step: 1, unit: "°/s" },
  { id: "switchTurn", label: "Impulso na troca", min: 0, max: 45, step: 1, unit: "°/s" },
  { id: "spinEase", label: "Duração total do impulso", min: 500, max: 3500, step: 100, unit: " ms" },
  { id: "spinPeakMs", label: "Tempo até pico", min: 80, max: 900, step: 10, unit: " ms" },
  { id: "returnBoost", label: "Impulso ao sair da marca", min: 0, max: 150, step: 5, unit: "%" },
  { id: "colorMs", label: "Cor ao sair da marca", min: 60, max: 650, step: 10, unit: " ms" },
  { id: "spinColorMs", label: "Cor sincronizada ao giro", min: 250, max: 1600, step: 50, unit: " ms" },
  { id: "speechMorphMs", label: "Escutando ⇄ Respondendo", min: 80, max: 800, step: 10, unit: " ms" },
  // Not in V37: how visibly the blue sphere answers the assistant's voice (0 = V37's original).
  { id: "talkResponse", label: "Reação à voz da IA", min: 0, max: 200, step: 5, unit: "%" },
  { id: "returnRotation", label: "Giro extra na volta", min: -180, max: 180, step: 5, unit: "°" },
  { id: "returnSpread", label: "Dispersão na volta", min: 40, max: 160, step: 5, unit: "%" },
];

const MODES: { id: LivingMode; label: string }[] = [
  { id: "listen", label: "Escutando" },
  { id: "talk", label: "IA respondendo" },
  { id: "logo", label: "Marca viva" },
];

interface Readout {
  mode: LivingMode;
  transition: string;
  omega: number;
  voice: number;
}

export function VoiceLabPage() {
  const settings = React.useRef<LivingSettings>(defaultSettings()).current;
  const engine = React.useRef<LivingEngine | null>(null);
  const [mode, setMode] = React.useState<LivingMode>("listen");
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [intensity, setIntensity] = React.useState(Math.round(TALK_INTENSITY * 100));
  const [panel, setPanel] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [readout, setReadout] = React.useState<Readout | null>(null);
  const [mic, setMic] = React.useState<MediaStream | null>(null);
  const [micError, setMicError] = React.useState<string | null>(null);
  const rms = useMicLevel(mic);

  // Pending way-in/way-back tests: a new click cancels the previous one (V37's token).
  const testTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTest = React.useCallback(() => {
    if (testTimer.current) clearTimeout(testTimer.current);
    testTimer.current = null;
  }, []);
  const queue = (ms: number, fn: () => void): void => {
    testTimer.current = setTimeout(() => {
      testTimer.current = null;
      fn();
    }, ms);
  };

  const go = React.useCallback((m: LivingMode, force = false) => {
    engine.current?.change(m, force);
    setMode(m);
  }, []);

  React.useEffect(() => {
    if (engine.current) engine.current.fallbackIntensity = intensity / 100;
  }, [intensity]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      const e = engine.current;
      if (e) setReadout({ mode: e.mode, transition: e.transition, omega: e.sphereOmega, voice: e.voice });
    }, 150);
    return () => clearInterval(timer);
  }, []);

  // The lab's own microphone: released when switched off and when the page goes away. A request
  // still pending then (permission prompt open) is released the moment it resolves.
  React.useEffect(() => () => mic?.getTracks().forEach((t) => t.stop()), [mic]);
  const micRequest = React.useRef(0);
  React.useEffect(
    () => () => {
      micRequest.current++;
      cancelTest();
    },
    [cancelTest],
  );

  const toggleMic = async (): Promise<void> => {
    const request = ++micRequest.current;
    if (mic) {
      setMic(null);
      return;
    }
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== micRequest.current) stream.getTracks().forEach((t) => t.stop());
      else setMic(stream);
    } catch (err) {
      if (request === micRequest.current) setMicError(err instanceof Error ? err.message : String(err));
    }
  };

  const onLogoSide = (): boolean => {
    const e = engine.current;
    return !!e && (e.mode === "logo" || e.transition !== "none");
  };
  const testOut = (from: "listen" | "talk"): void => {
    cancelTest();
    const fromLogo = onLogoSide();
    go(from);
    const back = 1000 * scheduleDuration(makeSchedule(settings, "ret"));
    const pause = from === "listen" ? (fromLogo ? back + 330 : 550) : (fromLogo ? back : 0) + 1100;
    queue(pause, () => go("logo", true));
  };
  const testBack = (): void => {
    cancelTest();
    const e = engine.current;
    if (e?.mode === "logo" && e.transition === "steady") return go("listen");
    if (e?.mode !== "logo") go("logo", true);
    const buildEnd = Math.max(
      ...makeSchedule(settings, "fwd").filter((s) => ["accel", "align", "draw", "finish"].includes(s.id)).map((s) => s.end),
    );
    queue(Math.max(350, Math.round((buildEnd + 0.3) * 1000)), () => go("listen"));
  };

  const reset = (): void => {
    Object.assign(settings, defaultSettings());
    redraw();
  };
  const copy = async (): Promise<void> => {
    const text = tuningText(settings);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copiado.");
    } catch {
      setCopied(text);
    }
  };

  const omega = readout ? readout.omega * (180 / Math.PI) : 0;
  const direction = omega < -0.23 ? "↺ anti-horário" : omega > 0.23 ? "↻ horário" : "· quase parado";

  return (
    <div className="min-h-full w-full bg-[#030c17] text-[#e8f6ff]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 lg:flex-row lg:items-start">
        <section className="flex min-w-0 flex-1 flex-col items-center gap-3" aria-label="Prévia ao vivo">
          <div className="flex w-full items-center justify-between gap-2">
            <Button asChild variant="ghost" size="sm" className="-ml-2 text-[#94b5c7] hover:bg-white/5 hover:text-white">
              <Link to={Paths.VOICE}>
                <ArrowLeft />
                /voice
              </Link>
            </Button>
            <p className="text-[11px] uppercase tracking-[0.27em] text-[#77a9c8]">Living Intelligence · V37 · laboratório</p>
          </div>
          <LivingOrb
            mode={mode}
            listenLevel={micVoice(rms ?? 0)}
            talkLevel={null}
            settings={settings}
            onEngine={(e) => (engine.current = e)}
            className="w-[min(92vw,620px,calc(100vh-15rem))]"
          />
          <p className="min-h-[18px] text-center text-xs uppercase tracking-[0.23em] text-[#7bcadf]" data-testid="lab-readout">
            {readout
              ? `${MODES.find((m) => m.id === readout.mode)?.label} · ${readout.transition} · ${direction} ${Math.abs(omega).toFixed(1)}°/s · voz ${readout.voice.toFixed(2)}`
              : "—"}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {MODES.map((m) => (
              <LabButton key={m.id} active={mode === m.id} onClick={() => (cancelTest(), go(m.id))}>
                {m.label}
              </LabButton>
            ))}
            <LabButton onClick={() => testOut("listen")}>↗ Ida pela escuta</LabButton>
            <LabButton onClick={() => testOut("talk")}>↗ Ida pela resposta</LabButton>
            <LabButton onClick={testBack}>↘ Testar volta</LabButton>
            <LabButton active={!!mic} onClick={() => void toggleMic()}>
              {mic ? "Desligar microfone" : "Ativar microfone (escuta)"}
            </LabButton>
            <label className="flex items-center gap-2 rounded-full border border-[#27506a] bg-[#0b1e30] px-3 py-1.5 text-xs text-[#a3c8da]">
              Voz IA simulada
              <input
                type="range"
                min={0}
                max={100}
                value={intensity}
                onChange={(e) => setIntensity(+e.target.value)}
                className="w-20 accent-[#69d5ed]"
                aria-label="Intensidade da voz simulada da IA"
              />
            </label>
            <LabButton active={panel} onClick={() => setPanel((v) => !v)}>
              {panel ? "Ocultar parâmetros" : "Mostrar parâmetros"}
            </LabButton>
          </div>
          {micError && <p role="alert" className="text-xs text-red-300">Microfone: {micError}</p>}
        </section>

        {panel && (
          <aside
            aria-label="Painel de calibração"
            className="w-full shrink-0 rounded-2xl border border-[#26526a] bg-[linear-gradient(130deg,rgba(10,32,50,.95),rgba(7,21,38,.96))] p-4 lg:max-h-[calc(100vh-7rem)] lg:w-[420px] lg:overflow-y-auto"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <strong className="text-sm text-[#e3f8ff]">Laboratório da transição</strong>
              <div className="flex gap-2">
                <LabButton onClick={reset}>Restaurar padrão</LabButton>
                <LabButton onClick={() => void copy()}>Copiar parametrização</LabButton>
              </div>
            </div>
            {copied && (
              <textarea
                readOnly
                value={copied}
                aria-label="Parametrização"
                className="mb-3 h-24 w-full resize-none rounded-md border border-[#47728a] bg-[#04101d] p-2 text-[11px]"
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              {SCALARS.map((c) => (
                <label key={c.id} className="grid gap-1 text-[11px] text-[#bcdae9]">
                  <span className="flex justify-between gap-1 font-semibold">
                    {c.label}
                    <output className="tabular-nums text-[#81e5f2]">{settings[c.id] + c.unit}</output>
                  </span>
                  <input
                    type="range"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={settings[c.id]}
                    onChange={(e) => {
                      settings[c.id] = +e.target.value;
                      setCopied(null);
                      redraw();
                    }}
                    className="w-full accent-[#56d3e8]"
                  />
                </label>
              ))}
            </div>
            {(["fwd", "ret"] as const).map((group) => (
              <div key={group} className="mt-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#77bbdc]">
                  {group === "fwd" ? "Ida · movimentos sobrepostos" : "Volta · liberação e recomposição"}
                </p>
                {STAGE_DEFS.filter((d) => d.group === group).map((d) => {
                  const st = settings.stages[d.id];
                  return (
                    <div key={d.id} className={cn("mb-2 rounded-xl border border-[#28536e] bg-[rgba(4,16,29,.58)] p-2.5", !st.on && "opacity-55")}>
                      <div className="flex items-center justify-between text-xs font-bold text-[#d5f1ff]">
                        {d.name}
                        <label className="flex items-center gap-1 text-[11px] font-normal text-[#9cc2d6]">
                          <input
                            type="checkbox"
                            checked={st.on}
                            onChange={(e) => {
                              st.on = e.target.checked;
                              redraw();
                            }}
                          />
                          Ativa
                        </label>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-3 text-[11px] text-[#b8d9ea]">
                        {(["start", "ms"] as const).map((field) => (
                          <label key={field} className="grid gap-1">
                            <span className="flex justify-between">
                              {field === "ms" ? "Duração" : d.relative ? "Atraso" : "Início"}
                              <output className="tabular-nums text-[#91e5f1]">{st[field]} ms</output>
                            </span>
                            <input
                              type="range"
                              min={0}
                              max={field === "ms" ? d.max : 2600}
                              step={field === "ms" ? 25 : 5}
                              value={st[field]}
                              onChange={(e) => {
                                st[field] = +e.target.value;
                                setCopied(null);
                                redraw();
                              }}
                              className="w-full accent-[#58d2e5]"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

function LabButton({ active, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "rounded-full border border-[#27506a] bg-[#0b1e30] px-3 py-2 text-xs font-semibold text-[#c1e7f6] hover:border-[#6ed0ef]",
        active && "border-[#4cc0e7] bg-[#135f85] text-white",
        className,
      )}
      {...props}
    />
  );
}

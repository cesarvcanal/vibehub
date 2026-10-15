import { config } from "../../config/env.js";
import { hostExecutor } from "../../runtime/host.js";
import { logger } from "../../utils/logger.js";
import {
  RUNS_PROBED,
  buildAgentFeedProbeScript,
  buildWorkflowProbeScript,
  parseAgentFeed,
  parseWorkflowProbe,
  type WorkflowActivity,
  type WorkflowAgent,
  type WorkflowFeedItem,
  type WorkflowRun,
} from "./workflowProbe.js";

/**
 * O WORKFLOW VISÍVEL — o que a tela não tinha como saber.
 *
 * A tool `Workflow` devolve na hora ("Workflow launched in background. Run ID: wf_…") e o turno
 * ACABA: o modelo diz "te trago quando voltar" e fica calado por minutos enquanto uma frota de
 * subagentes trabalha. No terminal do Claude Code isso aparece como uma árvore viva; no chat do
 * painel não aparecia NADA — e quem estava do outro lado lia aquilo como "ele terminou" (produção,
 * 2026-10-02). O stream do driver também não ajuda: entre o `tool_use` e a notificação final não
 * passa um único evento.
 *
 * O que existe de verdade é um DIÁRIO em disco, dentro do runner, escrito pelo harness:
 *
 *   <transcriptDir>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
 *     {"type":"launched"}
 *     {"type":"started","key":"v2:…","agentId":"a3c4…","label":"varre:front","phase":"Varredura"}
 *     {"type":"result","key":"v2:…","agentId":"a3c4…","result":{…}}
 *
 * e, ao lado, por subagente, um `agent-<id>.meta.json` (`description`, `workflowPhase`) e um
 * `agent-<id>.jsonl` com o transcript dele, linha a linha e com `timestamp`. O rótulo vem do DIÁRIO;
 * o meta e a linha "computed task text follows:" do transcript são os fallbacks. A PRIMEIRA linha do
 * transcript não serve: no harness 2.1.x ela é o cabeçalho "[Workflow harness — user request]" com
 * o pedido do usuário — igual em todos os subagentes.
 *
 * Este módulo lê isso de fora (uma sondagem só-leitura por `docker exec`, montada e lida em
 * ./workflowProbe.ts), transforma em um instantâneo e o manager publica no chat. Nada é escrito no
 * runner.
 *
 * As travas são deliberadas (a frota pode durar uma hora e ninguém quer um laço no servidor): uma
 * sondagem por card, só enquanto alguém está com o chat aberto, parada sozinha quando o diário
 * silencia sem agente em voo, e um teto duro de tempo além do qual ela desiste de qualquer jeito.
 */

/** Nada em voo: todo subagente que começou já devolveu (e pelo menos um começou). Conta pelo
 *  TOTAL do diário, não pela lista desenhada — a lista tem teto, a frota não. PURE. */
export function runSettled(run: WorkflowRun): boolean {
  return run.total > 0 && run.done >= run.total;
}

function sameActivity(a: WorkflowActivity | undefined, b: WorkflowActivity | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "tool" && b.kind === "tool") return a.tool === b.tool && a.target === b.target;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "thinking" && b.kind === "thinking") return a.since === b.since;
  return false;
}

function agentChanged(a: WorkflowAgent, b: WorkflowAgent | undefined): boolean {
  return (
    !b || a.id !== b.id || a.status !== b.status || a.label !== b.label || a.phase !== b.phase ||
    a.toolCount !== b.toolCount || a.startedAt !== b.startedAt || a.endedAt !== b.endedAt ||
    !sameActivity(a.activity, b.activity)
  );
}

/** Mudou alguma coisa que valha um quadro novo na tela? `lastAt` sozinho não: ele anda a cada
 *  linha do transcript, e o que a tela mostra dele já vem pela atividade. PURE. */
export function runChanged(previous: WorkflowRun | undefined, next: WorkflowRun): boolean {
  if (!previous) return true;
  if (previous.runId !== next.runId || previous.at !== next.at) return true;
  if (previous.finished !== next.finished) return true;
  if (previous.total !== next.total || previous.done !== next.done) return true;
  if (previous.phases.join("\n") !== next.phases.join("\n")) return true;
  if (previous.agents.length !== next.agents.length) return true;
  return previous.agents.some((a, i) => agentChanged(a, next.agents[i]));
}

/* ------------------------------------------------------------------ a sondagem */

/** De quanto em quanto a frota é relida. Um diário anda em segundos, não em milissegundos. */
export const WATCH_INTERVAL_MS = 4_000;
/** Diário parado por tanto tempo, sem nada em voo ⇒ a rodada acabou e a sondagem se encerra. */
export const WATCH_QUIET_MS = 90_000;
/** Teto duro: nenhuma sondagem vive mais que isto, aconteça o que acontecer. */
export const WATCH_MAX_MS = 60 * 60_000;
/** Sondagens seguidas com erro antes de desistir — runner caído não se resolve insistindo. */
export const WATCH_MAX_FAILURES = 5;
/**
 * Sondagens seguidas SEM rodada nenhuma antes de desistir. Um `Workflow` que morre antes de escrever
 * o diário (script com erro de sintaxe) não deixa nada para ler: sem isto, a sondagem dele ficaria
 * batendo no runner de 4 em 4 segundos até o teto de uma hora, por nada.
 */
export const WATCH_MAX_EMPTY = 15;

interface TrackedRun {
  last: WorkflowRun;
  /** A última vez que ESTA rodada se mexeu (ou que não havia ninguém olhando). */
  movedAt: number;
}

interface Watch {
  timer: NodeJS.Timeout;
  /** Quando a sondagem começou — o teto duro mede daqui. */
  startedAt: number;
  failures: number;
  /** Tiques seguidos sem rodada nenhuma no diretório. */
  empty: number;
  /** Uma sondagem em voo: o tique seguinte não abre outra em cima dela. */
  busy: boolean;
  runs: Map<string, TrackedRun>;
  publish: (run: WorkflowRun) => void;
}

const watches = new Map<string, Watch>();

/**
 * O ÚLTIMO instantâneo publicado por card, vivo DEPOIS que a sondagem se encerra: é o que uma aba
 * que abre agora precisa receber para desenhar a frota que acabou de terminar (e a que ainda roda).
 * Some com o driver do card — nunca cresce além dos cards abertos.
 */
const lastRuns = new Map<string, WorkflowRun[]>();

export interface WatchDeps {
  /** Onde ficam as rodadas desta sessão, e os scripts ao lado. `null` = ainda não dá pra saber. */
  dirs: () => { runs: string; scripts: string } | null;
  /** Alguém está com o chat deste card aberto? Sem ninguém olhando, não se sonda. */
  watchers: () => number;
  /** O instantâneo mudou: publique. */
  publish: (run: WorkflowRun) => void;
  /** Rótulo de log (o slug do card). */
  label: string;
  now?: () => number;
}

/** Guarda o quadro publicado, para a aba que conectar depois. */
function remember(cardId: string, run: WorkflowRun): void {
  const kept = (lastRuns.get(cardId) ?? []).filter((r) => r.runId !== run.runId);
  kept.push(run);
  lastRuns.set(cardId, kept.slice(-RUNS_PROBED));
}

/**
 * Desliga a sondagem DIZENDO que desligou: toda rodada que ficou em aberto recebe um último quadro
 * marcado como terminado. Sem isto, desistir (teto de tempo, runner caído, frota que nunca escreveu)
 * deixava o painel — e toda aba que reconectasse depois — girando para sempre numa frota que já não
 * é acompanhada por ninguém.
 */
function closeWatch(cardId: string, reason: string, label: string): void {
  const watch = watches.get(cardId);
  if (!watch) return;
  for (const tracked of watch.runs.values()) {
    if (tracked.last.finished) continue;
    const closed: WorkflowRun = { ...tracked.last, finished: true };
    tracked.last = closed;
    remember(cardId, closed);
    try {
      watch.publish(closed);
    } catch {
      /* a tela fechou primeiro — não é motivo para a sondagem morrer de pé */
    }
  }
  logger.info({ card: label, reason, runs: watch.runs.size }, "workflow watch stopped");
  stopCardWorkflowWatch(cardId);
}

/**
 * Começa (ou mantém) a sondagem da frota deste card. Chamada a cada `tool_use` de Workflow: uma
 * segunda chamada com a sondagem já de pé apenas ESTENDE o silêncio tolerado — nunca abre um
 * segundo laço, nunca reinicia o teto duro.
 */
export function watchCardWorkflows(cardId: string, deps: WatchDeps): void {
  const now = deps.now ?? Date.now;
  const existing = watches.get(cardId);
  if (existing) {
    for (const tracked of existing.runs.values()) tracked.movedAt = now();
    existing.empty = 0;
    return;
  }
  const watch: Watch = {
    timer: null as unknown as NodeJS.Timeout,
    startedAt: now(),
    failures: 0,
    empty: 0,
    busy: false,
    runs: new Map(),
    publish: deps.publish,
  };
  const tick = async (): Promise<void> => {
    if (watches.get(cardId) !== watch) return; // parada entre um tique e outro
    if (watch.busy) return; // a sondagem anterior ainda não voltou: duas em voo se ultrapassam
    if (now() - watch.startedAt > WATCH_MAX_MS) {
      closeWatch(cardId, "ceiling", deps.label);
      return;
    }
    // Ninguém com o chat aberto: não se gasta um `docker exec` por ninguém. O relógio do silêncio
    // anda junto, senão a rodada seria dada como terminada só porque ninguém estava olhando.
    if (deps.watchers() <= 0) {
      for (const tracked of watch.runs.values()) tracked.movedAt = now();
      return;
    }
    const dirs = deps.dirs();
    if (!dirs) return; // sem id de sessão ainda — o próximo tique tenta de novo
    let runs: WorkflowRun[];
    watch.busy = true;
    try {
      const settled = [...watch.runs.values()].flatMap(({ last }) =>
        last.agents.filter((a) => a.status === "done").map((a) => `${last.runId}/${a.id}`));
      const { stdout } = await hostExecutor().runScript(
        buildWorkflowProbeScript(config.runner.container, dirs.runs, dirs.scripts, settled),
        { timeoutMs: 10_000 },
      );
      runs = parseWorkflowProbe(stdout, (runId) => watch.runs.get(runId)?.last);
      watch.failures = 0;
    } catch (err) {
      watch.failures += 1;
      logger.debug(
        { card: deps.label, detail: (err as Error).message, failures: watch.failures },
        "workflow probe failed",
      );
      if (watch.failures >= WATCH_MAX_FAILURES) closeWatch(cardId, "probe failures", deps.label);
      return;
    } finally {
      watch.busy = false;
    }
    if (watches.get(cardId) !== watch) return; // parada enquanto a sondagem corria
    if (runs.length === 0) {
      watch.empty += 1;
      if (watch.empty >= WATCH_MAX_EMPTY) closeWatch(cardId, "no journal", deps.label);
      return;
    }
    watch.empty = 0;
    for (const run of runs) {
      const tracked = watch.runs.get(run.runId);
      const movedAt = !tracked || tracked.last.at !== run.at ? now() : tracked.movedAt;
      // Terminada = silenciosa há bastante tempo E sem nada em voo. As duas condições juntas: uma
      // frota pode passar um minuto inteiro sem escrever enquanto um subagente longo pensa.
      run.finished = runSettled(run) && now() - movedAt >= WATCH_QUIET_MS;
      if (runChanged(tracked?.last, run)) {
        watch.runs.set(run.runId, { last: run, movedAt });
        remember(cardId, run);
        deps.publish(run);
      } else if (tracked) {
        tracked.movedAt = movedAt;
      }
    }
    // Só se encerra quando TODA rodada que esta sondagem acompanha chegou ao fim: um segundo
    // workflow disparado no meio mantém o laço vivo pelos dois.
    const live = [...watch.runs.values()];
    if (live.length > 0 && live.every((tracked) => tracked.last.finished)) {
      logger.info({ card: deps.label, runs: live.length }, "workflow finished — watch stopped");
      stopCardWorkflowWatch(cardId);
    }
  };
  watch.timer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
  watch.timer.unref?.();
  watches.set(cardId, watch);
  void tick();
}

/** Quantos passos o feed de um subagente traz: as últimas ações, não o transcript inteiro. */
export const FEED_REQUEST_ITEMS = 50;

/**
 * O feed de UM subagente, lido agora do runner (mesmo executor da sondagem da frota). Sob demanda:
 * só quando alguém abre o agente no painel. Lança `InvalidWorkflowIdError` para ids fora do formato
 * (antes de existir um comando) e o erro do executor quando o runner não responde.
 */
export async function readAgentFeed(runsDir: string, runId: string, agentId: string): Promise<WorkflowFeedItem[]> {
  const script = buildAgentFeedProbeScript(config.runner.container, runsDir, runId, agentId, FEED_REQUEST_ITEMS);
  const { stdout } = await hostExecutor().runScript(script, { timeoutMs: 10_000 });
  return parseAgentFeed(stdout);
}

/** Os últimos quadros publicados deste card — o que uma aba que acabou de abrir precisa ver. */
export function lastWorkflowRuns(cardId: string): WorkflowRun[] {
  return lastRuns.get(cardId) ?? [];
}

/** Encerra a sondagem (fim da rodada, driver morto, card pausado). Idempotente. */
export function stopCardWorkflowWatch(cardId: string): void {
  const watch = watches.get(cardId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(cardId);
}

/** O driver do card morreu: a frota dele não é mais assunto desta tela. */
export function forgetCardWorkflows(cardId: string): void {
  stopCardWorkflowWatch(cardId);
  lastRuns.delete(cardId);
}

/** Test hook: derruba toda sondagem viva e esquece os instantâneos. */
export function resetWorkflowWatchesForTesting(): void {
  for (const cardId of [...watches.keys()]) stopCardWorkflowWatch(cardId);
  lastRuns.clear();
}

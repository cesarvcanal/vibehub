import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { logger } from "../../utils/logger.js";

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
 *     {"type":"started","key":"v2:…","agentId":"a3c4…"}
 *     {"type":"result","key":"v2:…","agentId":"a3c4…","result":{…}}
 *
 * e, ao lado, um `agent-<id>.jsonl` por subagente cuja PRIMEIRA linha é a tarefa que ele recebeu —
 * o rótulo. Este módulo lê isso de fora (uma sondagem só-leitura por `docker exec`), transforma em
 * um instantâneo e o manager publica no chat. Nada é escrito no runner.
 *
 * As travas são deliberadas (a frota pode durar uma hora e ninguém quer um laço no servidor): uma
 * sondagem por card, só enquanto alguém está com o chat aberto, parada sozinha quando o diário
 * silencia sem agente em voo, e um teto duro de tempo além do qual ela desiste de qualquer jeito.
 */

/** Um subagente da frota, como o diário o conhece. */
export interface WorkflowAgent {
  /** `agentId` do harness — o nome do arquivo `agent-<id>.jsonl`. */
  id: string;
  /** A tarefa que ele recebeu, em uma linha. Pode vir vazia (arquivo ainda não escrito). */
  label: string;
  status: "running" | "done";
  /** O que ele devolveu, aparado — só nos que terminaram. */
  result?: string;
}

/** O instantâneo de UMA rodada de workflow. */
export interface WorkflowRun {
  /** `wf_…` — o diretório da rodada, e o id que o harness imprime no resultado da tool. */
  runId: string;
  /** O nome do script (`meta.name`), lido do arquivo do script ao lado. "" quando não dá pra saber. */
  name: string;
  /**
   * TODOS os subagentes que a rodada começou, e quantos já responderam — contados no diário inteiro,
   * não na lista abaixo. A lista é o que a tela desenha e tem teto; a contagem é a verdade, e é ela
   * que decide se a frota acabou. Sem essa separação, uma frota maior que o teto era dada como
   * concluída com meia dúzia de subagentes ainda trabalhando.
   */
  total: number;
  done: number;
  agents: WorkflowAgent[];
  /** mtime do diário, em ms: a última vez que a rodada se mexeu. */
  at: number;
  /** A rodada silenciou sem nada em voo — o painel pode parar o spinner. */
  finished: boolean;
}

/** Quantas rodadas a sondagem olha (as mais recentes). Duas cobrem "rodei de novo pra iterar". */
const RUNS_PROBED = 2;
/** Teto de subagentes LISTADOS por rodada — a contagem (`total`/`done`) é sempre do diário inteiro. */
const AGENTS_MAX = 200;

/**
 * A sondagem, como ela roda DENTRO do runner. Node porque o diário e os rótulos são JSON: fazer
 * isso em awk seria ilegível e quebradiço. Só lê — `readdir`, `stat`, `readFile` — e imprime UMA
 * linha JSON. Um diretório que não existe (nenhum workflow nesta sessão) imprime `[]`, não um erro.
 *
 * O `dir` chega como ARGUMENTO (`process.argv[1]`), nunca interpolado no corpo do script. PURE.
 */
export function buildWorkflowProbeScript(containerName: string, runsDir: string, scriptsDir: string): string {
  const js = `
const fs=require('fs'),p=require('path');
const PRE='computed task text follows:';
function head(file,bytes){
  let fd=null;
  try{
    fd=fs.openSync(file,'r');
    const buf=Buffer.alloc(bytes);
    const n=fs.readSync(fd,buf,0,bytes,0);
    return buf.slice(0,n).toString('utf8');
  }catch(e){return ''}
  finally{if(fd!==null)try{fs.closeSync(fd)}catch(e){}}
}
function label(file){
  try{
    const h=head(file,65536);
    const nl=h.indexOf('\\n');
    const o=JSON.parse(nl<0?h:h.slice(0,nl));
    let c=o&&o.message&&o.message.content;
    if(Array.isArray(c))c=c.map(function(b){return b&&b.text||''}).join(' ');
    if(typeof c!=='string')return '';
    const i=c.indexOf(PRE);
    return (i<0?c:c.slice(i+PRE.length)).replace(/\\s+/g,' ').trim().slice(0,200);
  }catch(e){return ''}
}
function nameOf(scriptsDir,runId){
  try{
    const hit=fs.readdirSync(scriptsDir).filter(function(n){return n.indexOf('-'+runId+'.js')>0})[0];
    return hit?hit.slice(0,hit.length-('-'+runId+'.js').length):'';
  }catch(e){return ''}
}
function main(dir,scriptsDir){
  let names=[];
  try{names=fs.readdirSync(dir)}catch(e){return []}
  const runs=[];
  for(const n of names){
    if(n.indexOf('wf_')!==0)continue;
    const d=p.join(dir,n);
    let st;try{st=fs.statSync(p.join(d,'journal.jsonl'))}catch(e){continue}
    runs.push({runId:n,dir:d,at:Math.round(st.mtimeMs)});
  }
  runs.sort(function(a,b){return b.at-a.at});
  const out=[];
  for(const r of runs.slice(0,${RUNS_PROBED})){
    let lines=[];
    try{lines=fs.readFileSync(p.join(r.dir,'journal.jsonl'),'utf8').split('\\n')}catch(e){}
    const agents=new Map();
    for(const l of lines){
      if(!l)continue;
      let o;try{o=JSON.parse(l)}catch(e){continue}
      if(!o||!o.agentId)continue;
      const a=agents.get(o.agentId)||{id:o.agentId,status:'running',label:''};
      if(o.type==='result'){
        a.status='done';
        const v=o.result;
        a.result=(typeof v==='string'?v:JSON.stringify(v==null?'':v)).replace(/\\s+/g,' ').slice(0,400);
      }
      agents.set(o.agentId,a);
    }
    const all=Array.from(agents.values());
    const done=all.filter(function(a){return a.status==='done'}).length;
    const list=all.slice(0,${AGENTS_MAX});
    for(const a of list)a.label=label(p.join(r.dir,'agent-'+a.id+'.jsonl'));
    out.push({runId:r.runId,name:nameOf(scriptsDir,r.runId),at:r.at,total:all.length,done:done,agents:list});
  }
  return out;
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'')));
`.trim();
  return (
    `docker exec ${shQuote(containerName)} node -e ${shQuote(js)} ` +
    `${shQuote(runsDir)} ${shQuote(scriptsDir)} 2>/dev/null || true`
  );
}

/**
 * Tira do rótulo o cabeçalho que TODO subagente de workflow carrega — "Trabalhe em /work/…/x." é a
 * mesma frase em todos eles e empurra pra fora da linha a única parte que diferencia um do outro.
 * Sobrando nada, o rótulo original volta inteiro: é melhor do que uma linha vazia. PURE.
 */
export function trimAgentLabel(raw: string): string {
  const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const withoutCwd = flat.replace(/^(trabalhe em|work in|working in|working directory:)\s+\S+[.:,]?\s*/i, "");
  const text = withoutCwd.trim() || flat;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** Lê a saída da sondagem. Lixo, vazio ou JSON quebrado viram `[]` — isto desenha uma tela. PURE. */
export function parseWorkflowProbe(stdout: string): WorkflowRun[] {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const runs: WorkflowRun[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const runId = typeof o.runId === "string" ? o.runId : "";
    if (!runId) continue;
    const rawAgents = Array.isArray(o.agents) ? o.agents : [];
    const agents: WorkflowAgent[] = [];
    for (const item of rawAgents) {
      if (!item || typeof item !== "object") continue;
      const a = item as Record<string, unknown>;
      const id = typeof a.id === "string" ? a.id : "";
      if (!id) continue;
      const done = a.status === "done";
      agents.push({
        id,
        label: trimAgentLabel(typeof a.label === "string" ? a.label : ""),
        status: done ? "done" : "running",
        ...(done && typeof a.result === "string" && a.result ? { result: a.result } : {}),
      });
    }
    const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : agents.length;
    const done = typeof o.done === "number" && Number.isFinite(o.done)
      ? o.done
      : agents.filter((a) => a.status === "done").length;
    runs.push({
      runId,
      name: typeof o.name === "string" ? o.name : "",
      total,
      done,
      agents,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      finished: false,
    });
  }
  return runs;
}

/** Nada em voo: todo subagente que começou já devolveu (e pelo menos um começou). Conta pelo
 *  TOTAL do diário, não pela lista desenhada — a lista tem teto, a frota não. PURE. */
export function runSettled(run: WorkflowRun): boolean {
  return run.total > 0 && run.done >= run.total;
}

/** Mudou alguma coisa que valha um quadro novo na tela? PURE. */
export function runChanged(previous: WorkflowRun | undefined, next: WorkflowRun): boolean {
  if (!previous) return true;
  if (previous.runId !== next.runId || previous.at !== next.at) return true;
  if (previous.finished !== next.finished) return true;
  if (previous.total !== next.total || previous.done !== next.done) return true;
  if (previous.agents.length !== next.agents.length) return true;
  return previous.agents.some((a, i) => {
    const b = next.agents[i];
    return !b || a.id !== b.id || a.status !== b.status || a.label !== b.label;
  });
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
      const { stdout } = await hostExecutor().runScript(
        buildWorkflowProbeScript(config.runner.container, dirs.runs, dirs.scripts),
        { timeoutMs: 10_000 },
      );
      runs = parseWorkflowProbe(stdout);
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

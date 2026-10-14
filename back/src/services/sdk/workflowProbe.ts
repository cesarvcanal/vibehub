import { shQuote } from "../../runtime/host.js";

/**
 * AS SONDAGENS DA FROTA — o JS que roda DENTRO do runner (por `docker exec … node -e`), os comandos
 * que o embrulham e a leitura do que ele imprime. Tudo aqui é PURO: nada executa, nada guarda estado.
 * Quem roda, quando e com quais travas é o laço em ./workflow.ts — onde também está descrito o que é
 * lido (diário, meta.json e transcript de cada subagente).
 */

/**
 * O que o subagente está fazendo AGORA, do jeito que dá para ler. O raciocínio (`thinking`) chega
 * com o texto vazio no transcript — e mesmo que não chegasse, não é para a tela: só o marcador e
 * desde quando.
 */
export type WorkflowActivity =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; since: number };

/** Um subagente da frota, como o diário o conhece. */
export interface WorkflowAgent {
  /** `agentId` do harness — o nome do arquivo `agent-<id>.jsonl`. */
  id: string;
  /** O rótulo do diário (ou do meta, ou a tarefa calculada), em uma linha. Pode vir vazio. */
  label: string;
  /** A fase do script em que ele roda (`phase` do diário / `workflowPhase` do meta). "" = sem fase. */
  phase: string;
  status: "running" | "done";
  /** O que ele devolveu, aparado — só nos que terminaram. */
  result?: string;
  /** Primeiro e último `timestamp` do transcript, em ms. Ausentes quando o arquivo não tem nenhum. */
  startedAt?: number;
  lastAt?: number;
  /** Só nos que terminaram: o último `timestamp` do transcript. */
  endedAt?: number;
  /** Ferramentas chamadas no trecho lido do transcript. */
  toolCount: number;
  /** `true` quando o transcript é maior que a cabeça + a cauda lidas: `toolCount` é um piso. */
  toolCountPartial?: boolean;
  activity?: WorkflowActivity;
}

/** O instantâneo de UMA rodada de workflow. */
export interface WorkflowRun {
  /** `wf_…` — o diretório da rodada, e o id que o harness imprime no resultado da tool. */
  runId: string;
  /** O nome do script (`meta.name`), lido do arquivo do script ao lado. "" quando não dá pra saber. */
  name: string;
  /** Os títulos de `meta.phases` do script, na ordem. [] quando não dá pra ler. */
  phases: string[];
  /** Quando a rodada começou (o primeiro `timestamp` dos subagentes; senão o menor mtime), em ms. */
  startedAt?: number;
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

/** Um passo do feed de UM subagente (sob demanda). `thinking` nunca carrega texto. */
export interface WorkflowFeedItem {
  /** `timestamp` da linha do transcript, em ms (0 quando a linha não tinha). */
  at: number;
  kind: "tool" | "text" | "thinking" | "result";
  tool?: string;
  target?: string;
  text?: string;
}

/** Quantas rodadas a sondagem olha (as mais recentes). Duas cobrem "rodei de novo pra iterar". */
export const RUNS_PROBED = 2;
/** Teto de subagentes LISTADOS por rodada — a contagem (`total`/`done`) é sempre do diário inteiro. */
const AGENTS_MAX = 200;
/**
 * Quanto de cada transcript a sondagem lê: a cabeça (início, tarefa) e a cauda (o agora). Nunca o
 * arquivo inteiro — um transcript passa fácil de 600KB, e a sondagem roda a cada 4s por até 200.
 */
const AGENT_HEAD_BYTES = 65_536;
const AGENT_TAIL_BYTES = 65_536;
/** O feed de um subagente lê só a cauda do transcript. */
const FEED_TAIL_BYTES = 262_144;
/** Teto de itens do feed. */
export const FEED_MAX_ITEMS = 200;

const RUN_ID_RE = /^wf_[a-z0-9-]+$/;
const AGENT_ID_RE = /^a[0-9a-f]+$/;

/**
 * Peças comuns às duas sondagens (o instantâneo da frota e o feed de um agente): ler um trecho de
 * arquivo, separar linhas completas, e transformar um bloco do transcript em algo legível.
 * `String.raw`: as barras invertidas chegam ao node como estão escritas.
 */
const PROBE_COMMON_JS = String.raw`
const fs=require('fs'),p=require('path');
function readAt(file,start,bytes){
  let fd=null;
  try{
    fd=fs.openSync(file,'r');
    const buf=Buffer.alloc(bytes);
    const n=fs.readSync(fd,buf,0,bytes,start);
    return buf.slice(0,n).toString('utf8');
  }catch(e){return ''}
  finally{if(fd!==null)try{fs.closeSync(fd)}catch(e){}}
}
function statOf(file){try{return fs.statSync(file)}catch(e){return null}}
function linesOf(text,cutHead,cutTail){const l=text.split('\n');if(cutTail)l.pop();if(cutHead)l.shift();return l}
function parse(l){if(!l)return null;try{const o=JSON.parse(l);return o&&typeof o==='object'?o:null}catch(e){return null}}
function ts(o){const t=typeof o.timestamp==='string'?Date.parse(o.timestamp):NaN;return Number.isFinite(t)?t:0}
function flat(s,max){s=String(s==null?'':s).replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max-1)+'…':s}
function blocks(o){const c=o.message&&o.message.content;return Array.isArray(c)?c:[]}
function target(name,input){
  const i=input&&typeof input==='object'?input:{};
  const pick=function(keys){for(const k of keys){const v=i[k];if(typeof v==='string'&&v.trim())return v}return ''};
  let t;
  if(name==='Bash')t=pick(['description','command']);
  else if(name==='Read'||name==='Edit'||name==='Write'||name==='MultiEdit'||name==='NotebookEdit')t=pick(['file_path','notebook_path','path']);
  else if(name==='Grep'||name==='Glob')t=pick(['pattern']);
  else if(name==='Agent'||name==='Task')t=pick(['description','subagent_type']);
  else t=pick(['description','file_path','path','pattern','url','query','command']);
  return flat(t,120);
}
function step(b,textMax){
  if(!b||typeof b!=='object')return null;
  if(b.type==='tool_use')return {kind:'tool',tool:String(b.name||'?'),target:target(b.name,b.input)};
  if(b.type==='text'){const t=flat(b.text,textMax);return t?{kind:'text',text:t}:null}
  if(b.type==='thinking'||b.type==='redacted_thinking')return {kind:'thinking'};
  return null;
}
`;

/**
 * A sondagem, como ela roda DENTRO do runner. Node porque o diário e os rótulos são JSON: fazer
 * isso em awk seria ilegível e quebradiço. Só lê — `readdir`, `stat`, leituras com teto — e imprime
 * UMA linha JSON. Um diretório que não existe (nenhum workflow nesta sessão) imprime `[]`.
 *
 * Argumentos: `process.argv[1]` = diretório das rodadas, `process.argv[2]` = diretório dos scripts.
 */
export const WORKFLOW_PROBE_JS = PROBE_COMMON_JS + String.raw`
const PRE='computed task text follows:';
const HARNESS='[Workflow harness';
function str(v){return typeof v==='string'?v:''}
function userText(o){
  const c=o.message&&o.message.content;
  if(typeof c==='string')return c;
  return Array.isArray(c)?c.map(function(b){return b&&b.type==='text'&&b.text||''}).join(' '):'';
}
// A tarefa calculada: a linha com PRE (qualquer uma, não só a primeira). Sem ela, a primeira fala
// do usuário que não seja o cabeçalho do harness (transcripts de versões antigas).
function taskOf(lines,raw){
  let fallback='';
  for(const l of lines){
    const o=parse(l);if(!o)continue;
    const c=userText(o);if(!c)continue;
    const i=c.indexOf(PRE);
    if(i>=0)return c.slice(i+PRE.length);
    if(!fallback&&o.type==='user'&&c.trim().indexOf(HARNESS)!==0)fallback=c;
  }
  // A linha da tarefa pode ter ficado cortada no fim da cabeça: tira o texto direto do JSON cru.
  const k=raw.indexOf(PRE);
  if(k>=0){let s=raw.slice(k+PRE.length,k+PRE.length+600);const q=s.search(/[^\\]"/);if(q>=0)s=s.slice(0,q+1);return s.replace(/\\[nrt]/g,' ')}
  return fallback;
}
function inspect(file){
  const out={startedAt:0,lastAt:0,mtime:0,toolCount:0,partial:false,activity:null,task:''};
  const st=statOf(file);if(!st||st.size<=0)return out;
  out.mtime=Math.round(st.mtimeMs);
  const size=st.size,whole=size<=${AGENT_HEAD_BYTES + AGENT_TAIL_BYTES};
  const headRaw=readAt(file,0,whole?size:${AGENT_HEAD_BYTES});
  const head=linesOf(headRaw,false,!whole);
  const tail=whole?head:linesOf(readAt(file,size-${AGENT_TAIL_BYTES},${AGENT_TAIL_BYTES}),true,false);
  out.partial=!whole;
  out.task=taskOf(head,headRaw);
  for(const l of head){const o=parse(l);if(o&&ts(o)){out.startedAt=ts(o);break}}
  const counted=whole?[head]:[head,tail];
  for(const part of counted)for(const l of part){
    const o=parse(l);if(!o||o.type!=='assistant')continue;
    for(const b of blocks(o))if(b&&b.type==='tool_use')out.toolCount++;
  }
  for(let i=tail.length-1;i>=0;i--){
    const o=parse(tail[i]);if(!o)continue;
    if(!out.lastAt)out.lastAt=ts(o);
    if(out.activity||o.type!=='assistant')continue;
    const bs=blocks(o);
    for(let j=bs.length-1;j>=0&&!out.activity;j--){
      const s=step(bs[j],160);
      if(s)out.activity=s.kind==='thinking'?{kind:'thinking',since:ts(o)}:s;
    }
    if(out.lastAt&&out.activity)break;
  }
  return out;
}
function metaOf(dir,id){
  try{const o=JSON.parse(fs.readFileSync(p.join(dir,'agent-'+id+'.meta.json'),'utf8'));return o&&typeof o==='object'?o:{}}
  catch(e){return {}}
}
// Fim do bloco que abre em 'open' ({ ou [), pulando o que estiver entre aspas.
function closeOf(src,open){
  let depth=0,q=null;
  for(let i=open;i<src.length;i++){
    const ch=src[i];
    if(q){if(ch==='\\'){i++;continue}if(ch===q)q=null;continue}
    if(ch==='"'||ch==="'"||ch==='${"`"}'){q=ch;continue}
    if(ch==='['||ch==='{')depth++;
    else if(ch===']'||ch==='}'){depth--;if(depth===0)return i}
  }
  return -1;
}
function phasesOf(src){
  const m=/export\s+const\s+meta\s*=\s*\{/.exec(src);if(!m)return [];
  const metaOpen=m.index+m[0].length-1,metaEnd=closeOf(src,metaOpen);if(metaEnd<0)return [];
  const meta=src.slice(metaOpen,metaEnd+1);
  const ph=/\bphases\s*:\s*\[/.exec(meta);if(!ph)return [];
  const open=ph.index+ph[0].length-1,end=closeOf(meta,open);if(end<0)return [];
  const re=/\btitle\s*:\s*(['"${"`"}])((?:\\.|(?!\1)[^\\])*)\1/g;
  const out=[];let r;
  while((r=re.exec(meta.slice(open,end+1))))out.push(r[2].replace(/\\(.)/g,'$1'));
  return out;
}
function scriptOf(scriptsDir,runId){
  try{
    const suffix='-'+runId+'.js';
    const hit=fs.readdirSync(scriptsDir).filter(function(n){return n.indexOf(suffix)>0})[0];
    if(!hit)return {name:'',phases:[]};
    return {name:hit.slice(0,hit.length-suffix.length),phases:phasesOf(readAt(p.join(scriptsDir,hit),0,32768))};
  }catch(e){return {name:'',phases:[]}}
}
function agentOf(dir,a){
  const meta=a.label&&a.phase?{}:metaOf(dir,a.id);
  const info=inspect(p.join(dir,'agent-'+a.id+'.jsonl'));
  const out={id:a.id,status:a.status,label:a.label||str(meta.description)||info.task,phase:a.phase||str(meta.workflowPhase),toolCount:info.toolCount};
  if(a.result!==undefined)out.result=a.result;
  if(info.startedAt)out.startedAt=info.startedAt;
  if(info.lastAt)out.lastAt=info.lastAt;
  if(a.status==='done'&&info.lastAt)out.endedAt=info.lastAt;
  if(info.partial)out.toolCountPartial=true;
  if(info.activity)out.activity=info.activity;
  return {agent:out,mtime:info.mtime};
}
function main(dir,scriptsDir){
  let names=[];
  try{names=fs.readdirSync(dir)}catch(e){return []}
  const runs=[];
  for(const n of names){
    if(n.indexOf('wf_')!==0)continue;
    const d=p.join(dir,n);
    const st=statOf(p.join(d,'journal.jsonl'));if(!st)continue;
    runs.push({runId:n,dir:d,at:Math.round(st.mtimeMs)});
  }
  runs.sort(function(a,b){return b.at-a.at});
  const out=[];
  for(const r of runs.slice(0,${RUNS_PROBED})){
    let lines=[];
    try{lines=fs.readFileSync(p.join(r.dir,'journal.jsonl'),'utf8').split('\n')}catch(e){}
    const agents=new Map();
    for(const l of lines){
      const o=parse(l);
      if(!o||!o.agentId)continue;
      const a=agents.get(o.agentId)||{id:o.agentId,status:'running',label:'',phase:''};
      if(o.type==='started'){if(!a.label)a.label=str(o.label);if(!a.phase)a.phase=str(o.phase)}
      if(o.type==='result'){
        a.status='done';
        const v=o.result;
        a.result=(typeof v==='string'?v:JSON.stringify(v==null?'':v)).replace(/\s+/g,' ').slice(0,400);
      }
      agents.set(o.agentId,a);
    }
    const all=Array.from(agents.values());
    const done=all.filter(function(a){return a.status==='done'}).length;
    const list=[];let first=0,oldest=0;
    for(const a of all.slice(0,${AGENTS_MAX})){
      const got=agentOf(r.dir,a);
      list.push(got.agent);
      if(got.agent.startedAt&&(!first||got.agent.startedAt<first))first=got.agent.startedAt;
      if(got.mtime&&(!oldest||got.mtime<oldest))oldest=got.mtime;
    }
    const script=scriptOf(scriptsDir,r.runId);
    const run={runId:r.runId,name:script.name,phases:script.phases,at:r.at,total:all.length,done:done,agents:list};
    if(first||oldest)run.startedAt=first||oldest;
    out.push(run);
  }
  return out;
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'')));
`.trim();

export function buildWorkflowProbeScript(containerName: string, runsDir: string, scriptsDir: string): string {
  return (
    `docker exec ${shQuote(containerName)} node -e ${shQuote(WORKFLOW_PROBE_JS)} ` +
    `${shQuote(runsDir)} ${shQuote(scriptsDir)} 2>/dev/null || true`
  );
}

/**
 * O feed de UM subagente, como roda dentro do runner: os últimos N passos lidos da CAUDA do
 * transcript. Argumentos: diretório das rodadas, runId, agentId, N. Os ids são revalidados aqui
 * (a mesma regex do lado de fora) antes de virarem caminho.
 */
export const AGENT_FEED_PROBE_JS = PROBE_COMMON_JS + String.raw`
function resultText(c){
  if(typeof c==='string')return c;
  return Array.isArray(c)?c.map(function(b){return b&&b.type==='text'&&b.text||''}).join(' '):'';
}
function main(dir,runId,agentId,max){
  if(!${RUN_ID_RE}.test(runId)||!${AGENT_ID_RE}.test(agentId))return [];
  const n=Math.max(1,Math.min(${FEED_MAX_ITEMS},parseInt(max,10)||1));
  const file=p.join(dir,runId,'agent-'+agentId+'.jsonl');
  const st=statOf(file);if(!st||st.size<=0)return [];
  const whole=st.size<=${FEED_TAIL_BYTES};
  const lines=linesOf(readAt(file,whole?0:st.size-${FEED_TAIL_BYTES},whole?st.size:${FEED_TAIL_BYTES}),!whole,false);
  const items=[];
  for(const l of lines){
    const o=parse(l);if(!o)continue;
    const at=ts(o);
    if(o.type==='assistant'){
      for(const b of blocks(o)){const s=step(b,300);if(s){s.at=at;items.push(s)}}
    }else if(o.type==='user'){
      for(const b of blocks(o))if(b&&b.type==='tool_result')items.push({at:at,kind:'result',text:flat(resultText(b.content),300)});
    }
  }
  return items.slice(-n);
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'',process.argv[3]||'',process.argv[4]||'')));
`.trim();

/** Um id de rodada ou de subagente fora do formato que o harness gera — o pedido, não o runner, errou. */
export class InvalidWorkflowIdError extends Error {}

/**
 * O comando do feed de um subagente. Os ids viram caminho dentro do runner: só passam os formatos
 * que o harness gera — qualquer outra coisa é recusada AQUI, antes de existir um comando. PURE.
 */
export function buildAgentFeedProbeScript(
  containerName: string,
  runsDir: string,
  runId: string,
  agentId: string,
  maxItems: number,
): string {
  if (!RUN_ID_RE.test(runId)) throw new InvalidWorkflowIdError(`invalid workflow run id: ${JSON.stringify(runId)}`);
  if (!AGENT_ID_RE.test(agentId)) throw new InvalidWorkflowIdError(`invalid workflow agent id: ${JSON.stringify(agentId)}`);
  const limit = Math.max(1, Math.min(FEED_MAX_ITEMS, Math.floor(Number.isFinite(maxItems) ? maxItems : 1)));
  return (
    `docker exec ${shQuote(containerName)} node -e ${shQuote(AGENT_FEED_PROBE_JS)} ` +
    `${shQuote(runsDir)} ${shQuote(runId)} ${shQuote(agentId)} ${shQuote(String(limit))} 2>/dev/null || true`
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

/* ------------------------------------------------------------------ leitura das saídas */

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Um instante em ms: número finito e positivo, ou nada. */
function asInstant(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A última linha da saída como JSON — o docker pode imprimir avisos antes dela. */
function lastJsonLine(stdout: string): unknown {
  const text = String(stdout ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  } catch {
    return undefined;
  }
}

function parseActivity(value: unknown): WorkflowActivity | undefined {
  const o = asFields(value);
  if (!o) return undefined;
  if (o.kind === "tool") {
    const tool = asString(o.tool);
    return tool ? { kind: "tool", tool, target: asString(o.target) } : undefined;
  }
  if (o.kind === "text") {
    const text = asString(o.text);
    return text ? { kind: "text", text } : undefined;
  }
  // Só o marcador: um texto que viesse junto (não vem, mas) não passa daqui.
  if (o.kind === "thinking") return { kind: "thinking", since: asInstant(o.since) ?? 0 };
  return undefined;
}

function parseAgent(value: unknown): WorkflowAgent | null {
  const a = asFields(value);
  const id = asString(a?.id);
  if (!a || !id) return null;
  const done = a.status === "done";
  const toolCount = typeof a.toolCount === "number" && Number.isFinite(a.toolCount) && a.toolCount > 0
    ? Math.floor(a.toolCount)
    : 0;
  const startedAt = asInstant(a.startedAt);
  const lastAt = asInstant(a.lastAt);
  const endedAt = done ? asInstant(a.endedAt) : undefined;
  const activity = parseActivity(a.activity);
  const result = done ? asString(a.result) : "";
  return {
    id,
    label: trimAgentLabel(asString(a.label)),
    phase: asString(a.phase),
    status: done ? "done" : "running",
    ...(result ? { result } : {}),
    toolCount,
    ...(a.toolCountPartial === true ? { toolCountPartial: true } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(activity ? { activity } : {}),
  };
}

/** Lê a saída da sondagem. Lixo, vazio ou JSON quebrado viram `[]` — isto desenha uma tela. PURE. */
export function parseWorkflowProbe(stdout: string): WorkflowRun[] {
  const parsed = lastJsonLine(stdout);
  if (!Array.isArray(parsed)) return [];
  const runs: WorkflowRun[] = [];
  for (const entry of parsed) {
    const o = asFields(entry);
    const runId = asString(o?.runId);
    if (!o || !runId) continue;
    const agents = (Array.isArray(o.agents) ? o.agents : [])
      .map(parseAgent)
      .filter((a): a is WorkflowAgent => a !== null);
    const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : agents.length;
    const done = typeof o.done === "number" && Number.isFinite(o.done)
      ? o.done
      : agents.filter((a) => a.status === "done").length;
    const startedAt = asInstant(o.startedAt);
    runs.push({
      runId,
      name: asString(o.name),
      phases: (Array.isArray(o.phases) ? o.phases : []).filter((t): t is string => typeof t === "string"),
      ...(startedAt !== undefined ? { startedAt } : {}),
      total,
      done,
      agents,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      finished: false,
    });
  }
  return runs;
}

const FEED_KINDS: ReadonlySet<WorkflowFeedItem["kind"]> = new Set(["tool", "text", "thinking", "result"]);

function isFeedKind(value: unknown): value is WorkflowFeedItem["kind"] {
  return typeof value === "string" && FEED_KINDS.has(value as WorkflowFeedItem["kind"]);
}

function parseFeedItem(value: unknown): WorkflowFeedItem | null {
  const o = asFields(value);
  const kind = o?.kind;
  if (!o || typeof o.at !== "number" || !Number.isFinite(o.at) || o.at < 0 || !isFeedKind(kind)) return null;
  const at = o.at;
  switch (kind) {
    case "tool": {
      const tool = asString(o.tool);
      return tool ? { at, kind: "tool", tool, target: asString(o.target) } : null;
    }
    case "text": {
      const text = asString(o.text);
      return text ? { at, kind: "text", text } : null;
    }
    case "result":
      return { at, kind: "result", text: asString(o.text) };
    case "thinking":
      return { at, kind: "thinking" };
  }
}

/** Lê a saída do feed de um subagente. Lixo vira `[]`; item com tipo errado é descartado. PURE. */
export function parseAgentFeed(stdout: string): WorkflowFeedItem[] {
  const parsed = lastJsonLine(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseFeedItem).filter((item): item is WorkflowFeedItem => item !== null);
}

import { shQuote } from "../../runtime/host.js";
import { asFields, asInstant, asString, lastJsonLine, type Fields } from "./fields.js";

/**
 * THE FLEET PROBES — the JS that runs INSIDE the runner (through `docker exec … node -e`), the commands
 * that wrap it and the parsing of what it prints. Everything here is PURE: nothing executes, nothing keeps state.
 * Who runs it, when and with which guards is the loop in ./workflow.ts — where what is
 * read is also described (journal, meta.json and each subagent's transcript).
 */

/**
 * What the subagent is doing NOW, in the form that can be read. The reasoning (`thinking`) arrives
 * with empty text in the transcript — and even if it did not, it is not for the screen: only the marker and
 * since when.
 */
export type WorkflowActivity =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; since: number };

/** A subagent of the fleet, as the journal knows it. */
export interface WorkflowAgent {
  /** The harness's `agentId` — the name of the `agent-<id>.jsonl` file. */
  id: string;
  /** The journal's label (or the meta's, or the computed task), on one line. May come empty. */
  label: string;
  /** The script phase it runs in (the journal's `phase` / the meta's `workflowPhase`). "" = no phase. */
  phase: string;
  /** `stopped` = it was in flight when the round ended (killed, or the probe gave up): it will never answer. */
  status: "running" | "done" | "stopped";
  /** What it returned, trimmed — only on the ones that finished. */
  result?: string;
  /** First and last `timestamp` of the transcript, in ms. Absent when the file has none. */
  startedAt?: number;
  lastAt?: number;
  /** Only on the ones that finished: the transcript's last `timestamp`. */
  endedAt?: number;
  /** Tools called in the stretch of the transcript that was read. */
  toolCount: number;
  /** `true` when the transcript is larger than the head + tail read: `toolCount` is a floor. */
  toolCountPartial?: boolean;
  activity?: WorkflowActivity;
}

/** The snapshot of ONE workflow round. */
export interface WorkflowRun {
  /** `wf_…` — the round's directory, and the id the harness prints in the tool's result. */
  runId: string;
  /** The script's name (`meta.name`), read from the script file next to it. "" when it cannot be told. */
  name: string;
  /** The titles of the script's `meta.phases`, in order. [] when it cannot be read. */
  phases: string[];
  /** When the round started (the subagents' first `timestamp`; otherwise the smallest mtime), in ms. */
  startedAt?: number;
  /**
   * ALL the subagents the round started, and how many have already answered — counted across the whole journal,
   * not in the list below. The list is what the screen draws and it has a cap; the count is the truth, and it is what
   * decides whether the fleet is done. Without this separation, a fleet larger than the cap was taken as
   * completed with half a dozen subagents still working.
   */
  total: number;
  done: number;
  agents: WorkflowAgent[];
  /** The journal's mtime, in ms: the last time the round moved. */
  at: number;
  /** The round went quiet with nothing in flight — the panel may stop the spinner. */
  finished: boolean;
  /**
   * The outcome the HARNESS wrote in the round's snapshot (`<base>/workflows/<runId>.json`). Absent
   * while it runs. It is the only source that knows about a KILLED round: its journal simply stops,
   * without the `result` of those in flight.
   */
  outcome?: WorkflowOutcome;
}

export type WorkflowOutcome = "completed" | "killed" | "failed";

/** The harness snapshot's `status`, normalised. Anything else (including "running") = no outcome. PURE. */
function workflowOutcome(status: unknown): WorkflowOutcome | undefined {
  if (typeof status !== "string") return undefined;
  const s = status.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "killed" || s === "cancelled" || s === "canceled" || s === "stopped") return "killed";
  if (s === "failed" || s === "error" || s === "errored") return "failed";
  return undefined;
}

/** A step of ONE subagent's feed (on demand). `thinking` never carries text. */
export interface WorkflowFeedItem {
  /** The transcript line's `timestamp`, in ms (0 when the line had none). */
  at: number;
  kind: "tool" | "text" | "thinking" | "result";
  tool?: string;
  target?: string;
  text?: string;
}

/** How many rounds the probe looks at (the most recent). Two cover "I ran it again to iterate". */
export const RUNS_PROBED = 2;
/** Cap on subagents LISTED per round — the count (`total`/`done`) is always from the whole journal. */
const AGENTS_MAX = 200;
/**
 * How much of each transcript the probe reads: the head (start, task) and the tail (the now). Never the
 * whole file — a transcript easily goes past 600KB, and the probe runs every 4s for up to 200.
 */
const AGENT_HEAD_BYTES = 65_536;
const AGENT_TAIL_BYTES = 65_536;
/** A subagent's feed reads only the transcript's tail. */
const FEED_TAIL_BYTES = 262_144;
/** Cap on feed items. */
export const FEED_MAX_ITEMS = 200;

const RUN_ID_RE = /^wf_[a-z0-9-]+$/;
const AGENT_ID_RE = /^a[0-9a-f]+$/;

/**
 * Pieces common to both probes (the fleet snapshot and an agent's feed): read a stretch of a
 * file, split complete lines, and turn a transcript block into something readable.
 * `String.raw`: the backslashes reach node as written.
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
 * The probe, as it runs INSIDE the runner. Node because the journal and the labels are JSON: doing
 * this in awk would be unreadable and brittle. It only reads — `readdir`, `stat`, capped reads — and prints
 * ONE JSON line. A directory that does not exist (no workflow in this session) prints `[]`.
 *
 * Arguments: `process.argv[1]` = rounds directory, `process.argv[2]` = scripts directory.
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
// O snapshot que o harness grava ao lado de scripts/ quando a rodada ACABA. Só o status interessa;
// o resto (resultado, progresso) pode ser grande — snapshot grande demais fica sem desfecho.
function outcomeOf(scriptsDir,runId){
  try{
    const f=p.join(p.dirname(scriptsDir),runId+'.json');
    const st=statOf(f);if(!st||st.size>8388608)return '';
    const o=JSON.parse(fs.readFileSync(f,'utf8'));
    return o&&typeof o.status==='string'?o.status.slice(0,32):'';
  }catch(e){return ''}
}
function main(dir,scriptsDir,settled){
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
      // Concluído que o back já tem: o transcript dele não muda mais, então não é relido.
      if(a.status==='done'&&settled.has(r.runId+'/'+a.id)){list.push({id:a.id,status:'done',settled:true});continue}
      const got=agentOf(r.dir,a);
      list.push(got.agent);
      if(got.agent.startedAt&&(!first||got.agent.startedAt<first))first=got.agent.startedAt;
      if(got.mtime&&(!oldest||got.mtime<oldest))oldest=got.mtime;
    }
    const script=scriptOf(scriptsDir,r.runId);
    const run={runId:r.runId,name:script.name,phases:script.phases,at:r.at,total:all.length,done:done,agents:list};
    if(first||oldest)run.startedAt=first||oldest;
    const outcome=outcomeOf(scriptsDir,r.runId);
    if(outcome)run.outcome=outcome;
    out.push(run);
  }
  return out;
}
const settled=new Set(String(process.argv[3]||'').split(',').filter(Boolean));
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'',settled)));
`.trim();

/**
 * `settled`: the completed ones the back already has whole, as "runId/agentId" — the probe returns only a
 * marker for them. A key outside the harness's format is discarded here.
 *
 * No `2>/dev/null || true`: the legitimate empty case (no round, a directory that does not exist yet) the
 * script itself already prints as `[]` with exit 0. The `|| true` turned a restarting runner, a
 * stopped container or a missing node into empty stdout — read as "no journal", until the probe took the
 * fleet as completed while it kept running. The exit code reaches the executor, which
 * rejects, and the tick counts a FAILURE, not an empty result. PURE.
 */
export function buildWorkflowProbeScript(
  containerName: string,
  runsDir: string,
  scriptsDir: string,
  settled: readonly string[] = [],
): string {
  const keys = settled.filter((key) => {
    const [runId = "", agentId = "", ...rest] = key.split("/");
    return rest.length === 0 && RUN_ID_RE.test(runId) && AGENT_ID_RE.test(agentId);
  });
  return (
    `docker exec ${shQuote(containerName)} node -e ${shQuote(WORKFLOW_PROBE_JS)} ` +
    `${shQuote(runsDir)} ${shQuote(scriptsDir)} ${shQuote(keys.join(","))}`
  );
}

/**
 * The feed of ONE subagent, as it runs inside the runner: the last N steps read from the transcript's
 * TAIL. Arguments: rounds directory, runId, agentId, N. The ids are revalidated here
 * (the same regex as outside) before they become a path.
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

/** A round or subagent id outside the format the harness generates — the request, not the runner, got it wrong. */
export class InvalidWorkflowIdError extends Error {}

/**
 * The command for a subagent's feed. The ids become a path inside the runner: only the formats
 * the harness generates pass — anything else is refused HERE, before a command exists. PURE.
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
    `${shQuote(runsDir)} ${shQuote(runId)} ${shQuote(agentId)} ${shQuote(String(limit))}`
  );
}

/**
 * Strips from the label the header EVERY workflow subagent carries — "Trabalhe em /work/…/x." is the
 * same sentence in all of them and pushes off the line the only part that tells one from another.
 * If nothing is left, the original label comes back whole: it is better than an empty line. PURE.
 */
export function trimAgentLabel(raw: string): string {
  const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const withoutCwd = flat.replace(/^(trabalhe em|work in|working in|working directory:)\s+\S+[.:,]?\s*/i, "");
  const text = withoutCwd.trim() || flat;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/* ------------------------------------------------------------------ parsing the outputs */

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
  // Only the marker: a text that came along (it does not, but) does not get past here.
  if (o.kind === "thinking") return { kind: "thinking", since: asInstant(o.since) ?? 0 };
  return undefined;
}

/** Round over: whoever did not answer will not answer any more. PURE. */
export function stopInFlight(agents: WorkflowAgent[]): WorkflowAgent[] {
  return agents.map((a) => (a.status === "running" ? { ...a, status: "stopped" as const } : a));
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

/** The completed one the probe did not re-read (`settled`), taken from the round's previous frame. */
function knownDoneAgent(value: unknown, previous: WorkflowRun | undefined): WorkflowAgent | null {
  const id = asString(asFields(value)?.id);
  return previous?.agents.find((a) => a.id === id && a.status === "done") ?? null;
}

/**
 * Parses the probe's output. Garbage, empty or broken JSON become `[]` — this draws a screen. The
 * marker of an already known completed one becomes the agent from the previous frame (`previous`); without it, the
 * marker goes away and the next tick reads it again. PURE.
 */
export function parseWorkflowProbe(
  stdout: string,
  previous: (runId: string) => WorkflowRun | undefined = () => undefined,
): WorkflowRun[] {
  const parsed = lastJsonLine(stdout);
  if (!Array.isArray(parsed)) return [];
  const runs: WorkflowRun[] = [];
  for (const entry of parsed) {
    const o = asFields(entry);
    const runId = asString(o?.runId);
    if (!o || !runId) continue;
    const before = previous(runId);
    const known: WorkflowAgent[] = [];
    const agents = (Array.isArray(o.agents) ? o.agents : [])
      .map((value) => {
        if (asFields(value)?.settled !== true) return parseAgent(value);
        const agent = knownDoneAgent(value, before);
        if (agent) known.push(agent);
        return agent;
      })
      .filter((a): a is WorkflowAgent => a !== null);
    const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : agents.length;
    const done = typeof o.done === "number" && Number.isFinite(o.done)
      ? o.done
      : agents.filter((a) => a.status === "done").length;
    // The probe only measures the start by the agents it read; the known ones come in with what was already known.
    const starts = [asInstant(o.startedAt), ...known.map((a) => a.startedAt)].filter((t): t is number => t !== undefined);
    const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
    const outcome = workflowOutcome(o.outcome);
    runs.push({
      runId,
      name: asString(o.name),
      phases: (Array.isArray(o.phases) ? o.phases : []).filter((t): t is string => typeof t === "string"),
      ...(startedAt !== undefined ? { startedAt } : {}),
      total,
      done,
      // Killed/failed: those in flight died with it. "completed" does not — the back gives a free tick
      // to the journal's last `result` (see workflow.ts) before taking anyone as stopped.
      agents: outcome === "killed" || outcome === "failed" ? stopInFlight(agents) : agents,
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      finished: false,
      ...(outcome ? { outcome } : {}),
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

/** Parses a subagent feed's output. Garbage becomes `[]`; an item of the wrong type is discarded. PURE. */
export function parseAgentFeed(stdout: string): WorkflowFeedItem[] {
  const parsed = lastJsonLine(stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseFeedItem).filter((item): item is WorkflowFeedItem => item !== null);
}

import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { asFields, asInstant, asString, lastJsonLine, type Fields } from "./fields.js";
import { summarizeToolResult, type ToolResultSummary } from "./toolResult.js";

/**
 * THE ON-DEMAND DETAIL — what opens when someone clicks an action or a subagent.
 *
 * The chat gets only the summary of each result (./toolResult.ts). The whole detail — the input, the
 * output, the reasoning that led to the action, a subagent's timeline — is already written by
 * Claude Code itself in the session transcript, inside the runner:
 *
 *   <transcriptDir>/<sessionId>.jsonl                          the main conversation
 *   <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl     each subagent
 *   <transcriptDir>/<sessionId>/subagents/agent-<id>.meta.json `toolUseId` of the call that spawned it
 *
 * So nothing new is stored: a read-only probe (`docker exec … node -e`, like the workflow one)
 * searches by id and returns the piece. It works for old conversations, for what was done through
 * the Terminal, and after any F5 or deploy. The build and parse functions are PURE; the ones that
 * execute are `readToolDetail`/`readAgentTimeline`.
 */

/** Claude tool use ids (`toolu_…`) and, to be safe, any short id with no slash or dot. */
const TOOL_ID_RE = /^[A-Za-z0-9_-]{6,100}$/;
export class InvalidDetailIdError extends Error {}

/** Caps on what comes back from the runner (the output goes through SSH and becomes a websocket frame). */
export const DETAIL_TEXT_MAX = 200_000;
const DETAIL_INPUT_MAX = 60_000;
const THINKING_MAX = 6_000;
const TIMELINE_ITEMS_MAX = 400;
const TIMELINE_TAIL_BYTES = 4 * 1024 * 1024;

const PROBE_COMMON = String.raw`
const fs=require('fs'),p=require('path');
function parse(l){try{const o=JSON.parse(l);return o&&typeof o==='object'?o:null}catch(e){return null}}
function ts(o){const t=typeof o.timestamp==='string'?Date.parse(o.timestamp):NaN;return Number.isFinite(t)?t:0}
function blocks(o){const c=o.message&&o.message.content;return Array.isArray(c)?c:[]}
function textOf(c){if(typeof c==='string')return c;return Array.isArray(c)?c.map(function(b){return b&&b.type==='text'&&b.text||''}).join('\n'):''}
function lc(t){t=String(t==null?'':t).replace(/\s+$/,'');return t===''?0:t.split('\n').length}
function cap(s,n){s=String(s==null?'':s);return s.length>n?s.slice(0,n):s}
function prune(v,max,d){d=d||0;if(v===null||typeof v==='number'||typeof v==='boolean')return v;if(typeof v==='string')return cap(v,max);if(d>=5)return null;
  if(Array.isArray(v))return v.slice(0,200).map(function(x){return prune(x,max,d+1)});
  if(typeof v==='object'){const o={};for(const k in v)if(v[k]!==undefined)o[k]=prune(v[k],max,d+1);return o}return null}
function sessions(dir){
  const out=[];
  let names=[];try{names=fs.readdirSync(dir)}catch(e){return out}
  for(const n of names){
    const f=p.join(dir,n);
    if(n.endsWith('.jsonl')){out.push(f);continue}
    const sd=p.join(f,'subagents');let ms=[];try{ms=fs.readdirSync(sd)}catch(e){continue}
    for(const m of ms)if(/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(m))out.push(p.join(sd,m));
  }
  return out.map(function(f){let m=0;try{m=fs.statSync(f).mtimeMs}catch(e){}return {f:f,m:m}}).sort(function(a,b){return b.m-a.m}).map(function(x){return x.f});
}
function agentOfFile(f){const m=/agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f);return m?m[1]:''}
function metaOf(f){try{return JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/,'.meta.json'),'utf8'))||{}}catch(e){return {}}}
`;

/**
 * An ACTION by id: the `tool_use` (input), the `tool_result` (text + structured), when each one
 * happened, the reasoning right before, and whose it is (main or which subagent). Arguments: dir, id.
 */
export const TOOL_DETAIL_PROBE_JS = PROBE_COMMON + String.raw`
function main(dir,id){
  if(!${TOOL_ID_RE}.test(id))return {error:'invalid-id'};
  for(const f of sessions(dir)){
    let raw;try{if(fs.statSync(f).size>96*1024*1024)continue;raw=fs.readFileSync(f,'utf8')}catch(e){continue}
    if(raw.indexOf(id)<0)continue;
    const lines=raw.split('\n');let use=null,useAt=-1,res=null;
    for(let i=0;i<lines.length;i++){
      if(lines[i].indexOf(id)<0)continue;
      const o=parse(lines[i]);if(!o)continue;
      // Só a conversa: o CLI também grava cópias da requisição (api-request-blob), sem horário nem
      // toolUseResult — se valessem, apagariam a saída estruturada e o "quando".
      if(o.type!=='assistant'&&o.type!=='user')continue;
      for(const b of blocks(o)){
        if(b&&b.type==='tool_use'&&b.id===id&&!use){use={o:o,b:b};useAt=i}
        if(b&&b.type==='tool_result'&&b.tool_use_id===id&&!res)res={o:o,b:b};
      }
    }
    if(!use&&!res)continue;
    let thinking='';
    for(let i=useAt-1;i>=0&&i>=useAt-60&&!thinking;i--){
      const o=parse(lines[i]);if(!o)continue;
      if(o.type==='user'&&!blocks(o).some(function(b){return b&&b.type==='tool_result'}))break;
      if(o.type!=='assistant')continue;
      const bs=blocks(o);
      for(let j=bs.length-1;j>=0;j--)if(bs[j]&&bs[j].type==='thinking'&&bs[j].thinking){thinking=bs[j].thinking;break}
    }
    const out={found:true,file:f.indexOf('/subagents/')>=0?'subagent':'main'};
    if(out.file==='subagent'){out.agentId=agentOfFile(f);const m=metaOf(f);if(m.description)out.agentDescription=cap(m.description,300)}
    if(use){out.name=String(use.b.name||'');out.input=prune(use.b.input,${DETAIL_INPUT_MAX});out.startedAt=ts(use.o)}
    if(res){
      const text=textOf(res.b.content);
      out.isError=res.b.is_error===true;out.text=cap(text,${DETAIL_TEXT_MAX});out.textLength=text.length;out.endedAt=ts(res.o);
      if(res.o.toolUseResult!==undefined)out.structured=prune(res.o.toolUseResult,${DETAIL_TEXT_MAX});
    }
    if(thinking)out.thinking=cap(thinking,${THINKING_MAX});
    const bgId=res&&res.o.toolUseResult&&res.o.toolUseResult.backgroundTaskId;
    if(typeof bgId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(bgId))out.background=background(raw,bgId,textOf(res.b.content));
    return out;
  }
  return {found:false};
}
// Um Bash em segundo plano: o resultado só diz para onde a saída vai. A saída real (o FIM dela, se
// for grande) vem do arquivo, e o estado da última notificação da tarefa; sem notificação, roda.
function background(raw,taskId,text){
  const bg={taskId:taskId,status:'running'};
  const tag='<task-id>'+taskId+'</task-id>';
  for(const l of raw.split('\n')){
    if(l.indexOf(tag)<0||l.indexOf('task-notification')<0)continue;
    const o=parse(l);if(!o||(o.type!=='user'&&o.type!=='queue-operation'))continue;
    const c=typeof o.content==='string'?o.content:textOf(o.message&&o.message.content);
    const m=/<status>([a-z_]+)<\/status>/.exec(c);
    if(c.indexOf(tag)>=0&&m)bg.status=m[1];
  }
  const pm=/Output is being written to: (\/\S+\/tasks\/[A-Za-z0-9_-]+\.output)/.exec(text);
  let size=-1;try{if(pm)size=fs.statSync(pm[1]).size}catch(e){}
  if(size<0){bg.missing=true;return bg}
  const n=Math.min(size,${DETAIL_TEXT_MAX});const buf=Buffer.alloc(n);
  const fd=fs.openSync(pm[1],'r');try{fs.readSync(fd,buf,0,n,size-n)}finally{fs.closeSync(fd)}
  bg.output=buf.toString('utf8');bg.outputLength=size;
  return bg;
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'')));
`.trim();

/**
 * A subagent's TIMELINE by the call that spawned it: finds its transcript (by the meta's
 * `toolUseId`, or by the `agentId` the call's result carries) and returns the steps —
 * reasoning, texts, tools with the raw, capped result (the back summarises). Arguments: dir, id.
 */
export const AGENT_TIMELINE_PROBE_JS = PROBE_COMMON + String.raw`
function findAgentFile(dir,id){
  const all=sessions(dir);
  for(const f of all){if(f.indexOf('/subagents/')<0)continue;const m=metaOf(f);if(m.toolUseId===id)return f}
  for(const f of all){
    if(f.indexOf('/subagents/')>=0)continue;
    let raw;try{raw=fs.readFileSync(f,'utf8')}catch(e){continue}
    if(raw.indexOf(id)<0)continue;
    for(const l of raw.split('\n')){
      if(l.indexOf(id)<0||l.indexOf('tool_result')<0)continue;
      const o=parse(l);if(!o)continue;
      const r=o.toolUseResult;let agent=r&&typeof r.agentId==='string'?r.agentId:'';
      if(!agent){for(const b of blocks(o))if(b&&b.type==='tool_result'&&b.tool_use_id===id){const m=/agentId:\s*([A-Za-z0-9_-]+)/.exec(textOf(b.content));if(m)agent=m[1]}}
      if(agent){const hit=all.find(function(x){return x.endsWith('/agent-'+agent+'.jsonl')});if(hit)return hit}
    }
  }
  return '';
}
function main(dir,id){
  if(!${TOOL_ID_RE}.test(id))return {error:'invalid-id'};
  const f=findAgentFile(dir,id);if(!f)return {found:false};
  let st;try{st=fs.statSync(f)}catch(e){return {found:false}}
  const whole=st.size<=${TIMELINE_TAIL_BYTES};
  let raw='';try{const fd=fs.openSync(f,'r');const n=whole?st.size:${TIMELINE_TAIL_BYTES};const buf=Buffer.alloc(n);fs.readSync(fd,buf,0,n,whole?0:st.size-n);fs.closeSync(fd);raw=buf.toString('utf8')}catch(e){return {found:false}}
  const lines=raw.split('\n');if(!whole)lines.shift();
  const meta=metaOf(f),items=[],byId=new Map();let prompt='',first=0,last=0;
  for(const l of lines){
    const o=parse(l);if(!o)continue;
    const at=ts(o);if(at){if(!first)first=at;last=at}
    if(o.type==='user'){
      const c=o.message&&o.message.content;
      if(!prompt&&typeof c==='string')prompt=cap(c,8000);
      for(const b of blocks(o)){
        if(b&&b.type==='tool_result'){const it=byId.get(b.tool_use_id);if(!it)continue;const text=textOf(b.content);
          it.result={isError:b.is_error===true,text:cap(text,1500),textLength:text.length,outputLines:lc(text)};
          const r=o.toolUseResult;if(r!==undefined){it.result.structured=prune(r,600);
            if(r&&(typeof r.stdout==='string'||typeof r.stderr==='string'))it.result.outputLines=lc(r.stdout)+lc(r.stderr)}
          it.endedAt=at}
        else if(!prompt&&b&&b.type==='text'&&b.text)prompt=cap(b.text,8000);
      }
    }else if(o.type==='assistant'){
      for(const b of blocks(o)){
        if(!b)continue;
        if(b.type==='thinking'&&b.thinking)items.push({kind:'thinking',at:at,text:cap(b.thinking,3000)});
        else if(b.type==='text'&&b.text&&b.text.trim())items.push({kind:'text',at:at,text:cap(b.text,6000)});
        else if(b.type==='tool_use'){const it={kind:'tool',at:at,id:String(b.id||''),name:String(b.name||''),input:prune(b.input,400)};items.push(it);byId.set(it.id,it)}
      }
    }
  }
  const tools=items.filter(function(i){return i.kind==='tool'}).length;
  return {found:true,agentId:agentOfFile(f),description:cap(meta.description||'',300),agentType:cap(meta.agentType||'',80),
    prompt:prompt,startedAt:first,lastAt:last,toolCount:tools,partial:!whole,items:items.slice(-${TIMELINE_ITEMS_MAX})};
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'')));
`.trim();

/** A probe's command. The id is validated HERE, before a command exists. PURE. */
export function buildDetailProbeScript(containerName: string, transcriptDir: string, id: string, which: "tool" | "agent"): string {
  if (!TOOL_ID_RE.test(id)) throw new InvalidDetailIdError(`invalid tool use id: ${JSON.stringify(id)}`);
  const js = which === "tool" ? TOOL_DETAIL_PROBE_JS : AGENT_TIMELINE_PROBE_JS;
  return `docker exec ${shQuote(containerName)} node -e ${shQuote(js)} ${shQuote(transcriptDir)} ${shQuote(id)}`;
}

/* ------------------------------------------------------------------ reading */

/** An action, whole. */
export interface ToolDetail {
  found: boolean;
  /** Whose: the main agent or a subagent (with its id and description). */
  by?: "main" | "subagent";
  agentId?: string;
  agentDescription?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  /** What the model read back. */
  text?: string;
  /** Real size of the text (`text` may have come truncated). */
  textLength?: number;
  /** The tool's `tool_use_result` (Read: file; Edit: patch; Bash: stdout/stderr…). */
  structured?: unknown;
  /** The reasoning right before the call — the "why". */
  thinking?: string;
  startedAt?: number;
  endedAt?: number;
  result?: ToolResultSummary;
  /** Bash with `run_in_background`: the real output, read from the task's file on each probe. */
  background?: BackgroundOutput;
}

/** The output of a background command. `status` comes from the task's notification (without it: `running`). */
export interface BackgroundOutput {
  taskId: string;
  status: string;
  /** The END of the output (up to `DETAIL_TEXT_MAX`). */
  output?: string;
  /** Real size of the file, in bytes. */
  outputLength?: number;
  /** The output file no longer exists in the runner (the container's /tmp was cleaned). */
  missing?: boolean;
}

function parseBackground(v: unknown): BackgroundOutput | undefined {
  const o = asFields(v);
  if (!o || !asString(o.taskId)) return undefined;
  const bg: BackgroundOutput = { taskId: asString(o.taskId), status: asString(o.status) || "running" };
  if (typeof o.output === "string") bg.output = o.output;
  if (typeof o.outputLength === "number") bg.outputLength = o.outputLength;
  if (o.missing === true) bg.missing = true;
  return bg;
}

/** Parses the output of an action's probe. Garbage becomes `{ found: false }`. PURE. */
export function parseToolDetail(stdout: string): ToolDetail {
  const o = asFields(lastJsonLine(stdout));
  if (!o || o.found !== true) return { found: false };
  const detail: ToolDetail = { found: true, by: o.file === "subagent" ? "subagent" : "main" };
  if (asString(o.agentId)) detail.agentId = asString(o.agentId);
  if (asString(o.agentDescription)) detail.agentDescription = asString(o.agentDescription);
  if (asString(o.name)) detail.name = asString(o.name);
  if (o.input !== undefined) detail.input = o.input;
  const hasResult = typeof o.text === "string" || o.structured !== undefined || o.isError === true;
  if (hasResult) {
    detail.isError = o.isError === true;
    detail.text = asString(o.text);
    if (typeof o.textLength === "number") detail.textLength = o.textLength;
    if (o.structured !== undefined) detail.structured = o.structured;
    detail.result = summarizeToolResult({ type: "tool_result", id: "", isError: detail.isError, text: detail.text, structured: detail.structured });
  }
  if (asString(o.thinking)) detail.thinking = asString(o.thinking);
  const background = parseBackground(o.background);
  if (background) detail.background = background;
  const startedAt = asInstant(o.startedAt);
  const endedAt = asInstant(o.endedAt);
  if (startedAt) detail.startedAt = startedAt;
  if (endedAt) detail.endedAt = endedAt;
  return detail;
}

/** A step in a subagent's timeline. */
export type TimelineItem =
  | { kind: "thinking" | "text"; at: number; text: string }
  | { kind: "tool"; at: number; id: string; name: string; input?: unknown; endedAt?: number; result?: ToolResultSummary };

export interface AgentTimeline {
  found: boolean;
  agentId?: string;
  description?: string;
  agentType?: string;
  /** The task it received (the first message of its transcript). */
  prompt?: string;
  startedAt?: number;
  lastAt?: number;
  toolCount?: number;
  /** The transcript is larger than the tail read: the oldest steps were left out. */
  partial?: boolean;
  items: TimelineItem[];
}

/** Parses the output of the timeline probe; each step's result already comes out summarised. PURE. */
export function parseAgentTimeline(stdout: string): AgentTimeline {
  const o = asFields(lastJsonLine(stdout));
  if (!o || o.found !== true) return { found: false, items: [] };
  const items: TimelineItem[] = [];
  for (const raw of Array.isArray(o.items) ? o.items : []) {
    const it = asFields(raw);
    if (!it) continue;
    const at = asInstant(it.at) ?? 0;
    if ((it.kind === "thinking" || it.kind === "text") && asString(it.text)) {
      items.push({ kind: it.kind, at, text: asString(it.text) });
    } else if (it.kind === "tool" && asString(it.id)) {
      const r = asFields(it.result);
      const endedAt = asInstant(it.endedAt);
      items.push({
        kind: "tool",
        at,
        id: asString(it.id),
        name: asString(it.name) || "?",
        ...(it.input !== undefined ? { input: it.input } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(r ? { result: summarizeToolResult({ type: "tool_result", id: "", isError: r.isError === true, text: asString(r.text), structured: r.structured, outputLines: typeof r.outputLines === "number" ? r.outputLines : undefined }) } : {}),
      });
    }
  }
  return {
    found: true,
    ...(asString(o.agentId) ? { agentId: asString(o.agentId) } : {}),
    ...(asString(o.description) ? { description: asString(o.description) } : {}),
    ...(asString(o.agentType) ? { agentType: asString(o.agentType) } : {}),
    ...(asString(o.prompt) ? { prompt: asString(o.prompt) } : {}),
    ...(asInstant(o.startedAt) ? { startedAt: asInstant(o.startedAt) } : {}),
    ...(asInstant(o.lastAt) ? { lastAt: asInstant(o.lastAt) } : {}),
    ...(typeof o.toolCount === "number" ? { toolCount: o.toolCount } : {}),
    ...(o.partial === true ? { partial: true } : {}),
    items,
  };
}

/** A probe's ceiling. Generous: with the runner loaded, reading a large transcript takes over 15s, and
 *  whoever opened the detail would rather wait than see "não deu para ler" (the front asks again on its own). */
const DETAIL_PROBE_TIMEOUT_MS = 60_000;

/** Reads an action from the runner now. Throws `InvalidDetailIdError` (crooked id) or the executor's error. */
export async function readToolDetail(transcriptDir: string, id: string): Promise<ToolDetail> {
  const { stdout } = await hostExecutor().runScript(buildDetailProbeScript(config.runner.container, transcriptDir, id, "tool"), { timeoutMs: DETAIL_PROBE_TIMEOUT_MS });
  return parseToolDetail(stdout);
}

/** Reads a subagent's timeline from the runner now. */
export async function readAgentTimeline(transcriptDir: string, toolUseId: string): Promise<AgentTimeline> {
  const { stdout } = await hostExecutor().runScript(buildDetailProbeScript(config.runner.container, transcriptDir, toolUseId, "agent"), { timeoutMs: DETAIL_PROBE_TIMEOUT_MS });
  return parseAgentTimeline(stdout);
}

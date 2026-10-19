import { config } from "../../config/env.js";
import { hostExecutor, shQuote } from "../../runtime/host.js";
import { summarizeToolResult, type ToolResultSummary } from "./toolResult.js";

/**
 * O DETALHE SOB DEMANDA — o que abre quando alguém clica numa ação ou num subagente.
 *
 * O chat recebe só o resumo de cada resultado (./toolResult.ts). O detalhe inteiro — o input, a
 * saída, o raciocínio que levou à ação, a linha do tempo de um subagente — já está gravado pelo
 * próprio Claude Code no transcript da sessão, dentro do runner:
 *
 *   <transcriptDir>/<sessionId>.jsonl                          a conversa principal
 *   <transcriptDir>/<sessionId>/subagents/agent-<id>.jsonl     cada subagente
 *   <transcriptDir>/<sessionId>/subagents/agent-<id>.meta.json `toolUseId` da chamada que o disparou
 *
 * Então nada novo é guardado: uma sondagem só-leitura (`docker exec … node -e`, como a do workflow)
 * procura pelo id e devolve o pedaço. Vale para conversas antigas, para o que foi feito pelo
 * Terminal e depois de qualquer F5 ou deploy. As funções de montar e ler são PURAS; quem executa é
 * `readToolDetail`/`readAgentTimeline`.
 */

/** Ids de tool use do Claude (`toolu_…`) e, por garantia, qualquer id curto sem barra nem ponto. */
const TOOL_ID_RE = /^[A-Za-z0-9_-]{6,100}$/;
export class InvalidDetailIdError extends Error {}

/** Tetos do que volta do runner (a saída passa pelo SSH e vira um frame de websocket). */
export const DETAIL_TEXT_MAX = 200_000;
export const DETAIL_INPUT_MAX = 60_000;
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
 * Uma AÇÃO pelo id: o `tool_use` (input), o `tool_result` (texto + estruturado), quando cada um
 * aconteceu, o raciocínio logo antes, e de quem é (principal ou qual subagente). Argumentos: dir, id.
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
      for(const b of blocks(o)){
        if(b&&b.type==='tool_use'&&b.id===id){use={o:o,b:b};useAt=i}
        if(b&&b.type==='tool_result'&&b.tool_use_id===id)res={o:o,b:b};
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
    return out;
  }
  return {found:false};
}
console.log(JSON.stringify(main(process.argv[1]||'',process.argv[2]||'')));
`.trim();

/**
 * A LINHA DO TEMPO de um subagente pela chamada que o disparou: acha o transcript dele (pelo
 * `toolUseId` do meta, ou pelo `agentId` que o resultado da chamada traz) e devolve os passos —
 * raciocínio, textos, ferramentas com o resultado cru e capado (o back resume). Argumentos: dir, id.
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

/** O comando de uma sondagem. O id é validado AQUI, antes de existir um comando. PURE. */
export function buildDetailProbeScript(containerName: string, transcriptDir: string, id: string, which: "tool" | "agent"): string {
  if (!TOOL_ID_RE.test(id)) throw new InvalidDetailIdError(`invalid tool use id: ${JSON.stringify(id)}`);
  const js = which === "tool" ? TOOL_DETAIL_PROBE_JS : AGENT_TIMELINE_PROBE_JS;
  return `docker exec ${shQuote(containerName)} node -e ${shQuote(js)} ${shQuote(transcriptDir)} ${shQuote(id)}`;
}

/* ------------------------------------------------------------------ leitura */

type Fields = Record<string, unknown>;
const asFields = (v: unknown): Fields | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Fields) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const instant = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

function lastJson(stdout: string): Fields | null {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return asFields(JSON.parse(text.slice(text.lastIndexOf("\n") + 1)));
  } catch {
    return null;
  }
}

/** Uma ação, inteira. */
export interface ToolDetail {
  found: boolean;
  /** De quem: o agente principal ou um subagente (com o id e a descrição dele). */
  by?: "main" | "subagent";
  agentId?: string;
  agentDescription?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  /** O que o modelo leu de volta. */
  text?: string;
  /** Tamanho real do texto (o `text` pode ter vindo cortado). */
  textLength?: number;
  /** O `tool_use_result` da ferramenta (Read: arquivo; Edit: patch; Bash: stdout/stderr…). */
  structured?: unknown;
  /** O raciocínio logo antes da chamada — o "por quê". */
  thinking?: string;
  startedAt?: number;
  endedAt?: number;
  result?: ToolResultSummary;
}

/** Lê a saída da sondagem de uma ação. Lixo vira `{ found: false }`. PURE. */
export function parseToolDetail(stdout: string): ToolDetail {
  const o = lastJson(stdout);
  if (!o || o.found !== true) return { found: false };
  const detail: ToolDetail = { found: true, by: o.file === "subagent" ? "subagent" : "main" };
  if (str(o.agentId)) detail.agentId = str(o.agentId);
  if (str(o.agentDescription)) detail.agentDescription = str(o.agentDescription);
  if (str(o.name)) detail.name = str(o.name);
  if (o.input !== undefined) detail.input = o.input;
  const hasResult = typeof o.text === "string" || o.structured !== undefined || o.isError === true;
  if (hasResult) {
    detail.isError = o.isError === true;
    detail.text = str(o.text);
    if (typeof o.textLength === "number") detail.textLength = o.textLength;
    if (o.structured !== undefined) detail.structured = o.structured;
    detail.result = summarizeToolResult({ type: "tool_result", id: "", isError: detail.isError, text: detail.text, structured: detail.structured });
  }
  if (str(o.thinking)) detail.thinking = str(o.thinking);
  const startedAt = instant(o.startedAt);
  const endedAt = instant(o.endedAt);
  if (startedAt) detail.startedAt = startedAt;
  if (endedAt) detail.endedAt = endedAt;
  return detail;
}

/** Um passo da linha do tempo de um subagente. */
export type TimelineItem =
  | { kind: "thinking" | "text"; at: number; text: string }
  | { kind: "tool"; at: number; id: string; name: string; input?: unknown; endedAt?: number; result?: ToolResultSummary };

export interface AgentTimeline {
  found: boolean;
  agentId?: string;
  description?: string;
  agentType?: string;
  /** A tarefa que ele recebeu (a primeira fala do transcript dele). */
  prompt?: string;
  startedAt?: number;
  lastAt?: number;
  toolCount?: number;
  /** O transcript é maior do que a cauda lida: os passos mais antigos ficaram de fora. */
  partial?: boolean;
  items: TimelineItem[];
}

/** Lê a saída da sondagem da linha do tempo; o resultado de cada passo já sai resumido. PURE. */
export function parseAgentTimeline(stdout: string): AgentTimeline {
  const o = lastJson(stdout);
  if (!o || o.found !== true) return { found: false, items: [] };
  const items: TimelineItem[] = [];
  for (const raw of Array.isArray(o.items) ? o.items : []) {
    const it = asFields(raw);
    if (!it) continue;
    const at = instant(it.at) ?? 0;
    if ((it.kind === "thinking" || it.kind === "text") && str(it.text)) {
      items.push({ kind: it.kind, at, text: str(it.text) });
    } else if (it.kind === "tool" && str(it.id)) {
      const r = asFields(it.result);
      const endedAt = instant(it.endedAt);
      items.push({
        kind: "tool",
        at,
        id: str(it.id),
        name: str(it.name) || "?",
        ...(it.input !== undefined ? { input: it.input } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(r ? { result: summarizeToolResult({ type: "tool_result", id: "", isError: r.isError === true, text: str(r.text), structured: r.structured, outputLines: typeof r.outputLines === "number" ? r.outputLines : undefined }) } : {}),
      });
    }
  }
  return {
    found: true,
    ...(str(o.agentId) ? { agentId: str(o.agentId) } : {}),
    ...(str(o.description) ? { description: str(o.description) } : {}),
    ...(str(o.agentType) ? { agentType: str(o.agentType) } : {}),
    ...(str(o.prompt) ? { prompt: str(o.prompt) } : {}),
    ...(instant(o.startedAt) ? { startedAt: instant(o.startedAt) } : {}),
    ...(instant(o.lastAt) ? { lastAt: instant(o.lastAt) } : {}),
    ...(typeof o.toolCount === "number" ? { toolCount: o.toolCount } : {}),
    ...(o.partial === true ? { partial: true } : {}),
    items,
  };
}

/** Lê uma ação do runner agora. Lança `InvalidDetailIdError` (id torto) ou o erro do executor. */
export async function readToolDetail(transcriptDir: string, id: string): Promise<ToolDetail> {
  const { stdout } = await hostExecutor().runScript(buildDetailProbeScript(config.runner.container, transcriptDir, id, "tool"), { timeoutMs: 15_000 });
  return parseToolDetail(stdout);
}

/** Lê a linha do tempo de um subagente do runner agora. */
export async function readAgentTimeline(transcriptDir: string, toolUseId: string): Promise<AgentTimeline> {
  const { stdout } = await hostExecutor().runScript(buildDetailProbeScript(config.runner.container, transcriptDir, toolUseId, "agent"), { timeoutMs: 15_000 });
  return parseAgentTimeline(stdout);
}

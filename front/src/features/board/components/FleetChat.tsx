import * as React from "react";
import { AlertCircle, BookCheck, Bot, Braces, Bug, ChevronRight, FlaskConical, Gauge, Scale, ShieldCheck, Telescope, type LucideIcon } from "lucide-react";
import { ANALYSIS_DIMENSIONS, type AnalysisDimension } from "@/api/types";
import { Markdown } from "@/features/board/components/ChatView";
import { TypingDots } from "@/features/board/components/PeerTypingIndicator";
import {
  chatClockText, isLongSpeech, type ChatReply, type ChatSpeaker, type FleetChatEntry,
} from "@/features/board/lib/fleetChat";
import { agentRole, type AgentReading, type AgentRole } from "@/features/board/lib/reviewFleet";
import { useT, type Translate } from "@/i18n";
import { cn } from "@/lib/utils";

const ENTRY_TEST_ID: Record<FleetChatEntry["kind"], string> = {
  message: "fleet-chat-message",
  typing: "fleet-chat-typing",
  stopped: "fleet-chat-stopped",
};

type AgentTone = AnalysisDimension | "context" | "judge" | "other";

const MESSAGE_ARRIVAL = "origin-bottom-left animate-message-arrival motion-reduce:animate-none";

const TONE_STYLE: Record<AgentTone, { icon: LucideIcon; solid: string; outline: string; name: string }> = {
  context: { icon: Telescope, solid: "bg-teal-400", outline: "border-teal-400 text-teal-300", name: "text-teal-300" },
  judge: { icon: Scale, solid: "bg-amber-400", outline: "border-amber-400 text-amber-300", name: "text-amber-300" },
  correctness: { icon: Bug, solid: "bg-sky-400", outline: "border-sky-400 text-sky-300", name: "text-sky-300" },
  security: { icon: ShieldCheck, solid: "bg-rose-400", outline: "border-rose-400 text-rose-300", name: "text-rose-300" },
  performance: { icon: Gauge, solid: "bg-orange-400", outline: "border-orange-400 text-orange-300", name: "text-orange-300" },
  contracts: { icon: Braces, solid: "bg-violet-400", outline: "border-violet-400 text-violet-300", name: "text-violet-300" },
  tests: { icon: FlaskConical, solid: "bg-lime-400", outline: "border-lime-400 text-lime-300", name: "text-lime-300" },
  repoRules: { icon: BookCheck, solid: "bg-fuchsia-400", outline: "border-fuchsia-400 text-fuchsia-300", name: "text-fuchsia-300" },
  other: { icon: Bot, solid: "bg-muted-foreground", outline: "border-muted-foreground text-muted-foreground", name: "text-foreground/90" },
};

function agentTone(role: AgentRole): AgentTone {
  switch (role.kind) {
    case "review":
    case "verification":
      return role.dimension;
    case "context":
    case "judge":
    case "other":
      return role.kind;
  }
}

function fleetAgentState(entry: FleetChatEntry): FleetAgentState {
  const agentId = entry.speaker.agentId;
  if (entry.kind === "message" && entry.at !== undefined) return { agentId, running: false, endedAt: entry.at };
  return { agentId, running: entry.kind === "typing" };
}

function chatEntryDomId(entryId: string): string {
  return `fleet-chat-${entryId}`;
}

export interface FleetAgentState {
  agentId: string;
  running: boolean;
  endedAt?: number;
}

type AgentDetail = (agent: FleetAgentState) => React.ReactNode;

export function FleetChat({ entries, label, agentDetail }: { entries: FleetChatEntry[]; label: string; agentDetail?: AgentDetail }) {
  const [openEntryIds, setOpenEntryIds] = React.useState<ReadonlySet<string>>(new Set());
  const [entryIdsOnOpen] = React.useState<ReadonlySet<string>>(() => new Set(entries.map((entry) => entry.id)));
  const toggleEntry = (entryId: string) => {
    setOpenEntryIds((open) => {
      const next = new Set(open);
      if (!next.delete(entryId)) next.add(entryId);
      return next;
    });
  };
  return (
    <ol aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      {entries.map((entry, index) => {
        const continues = entries[index - 1]?.speaker.agentId === entry.speaker.agentId;
        const detailOpen = agentDetail ? openEntryIds.has(entry.id) : undefined;
        const arrived = !entryIdsOnOpen.has(entry.id);
        return (
          <li
            key={entry.id}
            id={chatEntryDomId(entry.id)}
            data-arrived={arrived}
            className={cn("flex min-w-0 items-end gap-2", !continues && index > 0 && "mt-1", arrived && MESSAGE_ARRIVAL)}
          >
            {continues ? <span className="w-7 shrink-0" aria-hidden="true" /> : <Avatar speaker={entry.speaker} />}
            <ChatBubble
              entry={entry}
              showSpeaker={!continues}
              detailOpen={detailOpen}
              onToggleDetail={() => toggleEntry(entry.id)}
            >
              {agentDetail && detailOpen ? agentDetail(fleetAgentState(entry)) : null}
            </ChatBubble>
          </li>
        );
      })}
    </ol>
  );
}

function Avatar({ speaker }: { speaker: ChatSpeaker }) {
  const role = agentRole(speaker.label);
  return <ToneAvatar tone={agentTone(role)} isVerification={role.kind === "verification"} />;
}

function ToneAvatar({ tone, isVerification, className, style: inlineStyle }: {
  tone: AgentTone;
  isVerification: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const style = TONE_STYLE[tone];
  const Icon = style.icon;
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      data-verification={isVerification}
      style={inlineStyle}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full",
        isVerification ? cn("border-2 bg-background", style.outline) : cn("text-background", style.solid),
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

const FLEET_LINEUP: readonly AgentTone[] = ["context", ...ANALYSIS_DIMENSIONS, "judge"];

const GATHER_STAGGER_MS = 220;

const GHOST_BUBBLES: readonly { tone: AgentTone; lineWidths: readonly string[]; fade: string }[] = [
  { tone: "context", lineWidths: ["w-40", "w-28"], fade: "opacity-100" },
  { tone: "security", lineWidths: ["w-32"], fade: "opacity-70" },
  { tone: "correctness", lineWidths: ["w-44", "w-36", "w-20"], fade: "opacity-40" },
];

export function FleetGathering({ title, body }: { title: string; body: string }) {
  return (
    <section role="status" aria-label={title} className="flex min-w-0 flex-col gap-5 py-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex -space-x-1.5">
          {FLEET_LINEUP.map((tone, index) => (
            <ToneAvatar
              key={tone}
              tone={tone}
              isVerification={false}
              className="animate-fleet-gather ring-2 ring-background motion-reduce:animate-none"
              style={{ animationDelay: `${index * GATHER_STAGGER_MS}ms` }}
            />
          ))}
        </div>
        <p className="flex items-center gap-2 text-sm font-semibold">
          <TypingDots />
          {title}
        </p>
        <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
      <ol aria-hidden="true" className="flex min-w-0 flex-col gap-2.5">
        {GHOST_BUBBLES.map((bubble) => (
          <li key={bubble.tone} className={cn("flex items-end gap-2", bubble.fade)}>
            <ToneAvatar tone={bubble.tone} isVerification={false} className="opacity-60" />
            <div className="flex animate-pulse flex-col gap-1.5 rounded-xl rounded-bl-sm bg-muted px-2.5 py-2 motion-reduce:animate-none">
              {bubble.lineWidths.map((width, lineIndex) => (
                <span key={`${width}-${lineIndex}`} className={cn("h-2 max-w-full rounded-full bg-muted-foreground/30", width)} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChatBubble({
  entry, showSpeaker, detailOpen, onToggleDetail, children,
}: {
  entry: FleetChatEntry;
  showSpeaker: boolean;
  detailOpen: boolean | undefined;
  onToggleDetail: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <article
      data-testid={ENTRY_TEST_ID[entry.kind]}
      className={cn("min-w-0 max-w-[88%] rounded-xl bg-muted/50 px-2.5 py-1.5 text-xs leading-relaxed", showSpeaker ? "rounded-bl-sm" : "rounded-l-sm")}
    >
      {showSpeaker ? <SpeakerLine speaker={entry.speaker} detailOpen={detailOpen} onToggleDetail={onToggleDetail} /> : null}
      {entry.kind === "message" ? (
        <>
          {entry.replyTo ? <ReplyQuote reply={entry.replyTo} speaker={entry.speaker} /> : null}
          <ReadingBody reading={entry.reading} />
          {entry.at !== undefined ? <p className="mt-0.5 text-right text-[10px] text-muted-foreground">{chatClockText(entry.at)}</p> : null}
        </>
      ) : null}
      {entry.kind === "typing" ? (
        <p role="status" className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <TypingDots />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {entry.doing ? [entry.doing.tool, entry.doing.target].filter(Boolean).join(" · ") : t("review.fleet.typing")}
          </span>
        </p>
      ) : null}
      {entry.kind === "stopped" ? <StoppedNotice error={entry.error} /> : null}
      {children}
    </article>
  );
}

function StoppedNotice({ error }: { error: string | undefined }) {
  const t = useT();
  return (
    <div role="note" className="mt-1 flex min-w-0 items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium text-destructive">{t(error ? "review.fleet.failed" : "review.fleet.stoppedTitle")}</p>
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{error ? error : t("review.fleet.stopped")}</p>
      </div>
    </div>
  );
}

function SpeakerLine({
  speaker, detailOpen, onToggleDetail,
}: {
  speaker: ChatSpeaker;
  detailOpen: boolean | undefined;
  onToggleDetail: () => void;
}) {
  const t = useT();
  const name = fleetAgentName(speaker.label, t);
  const nameStyle = cn("font-semibold", TONE_STYLE[agentTone(agentRole(speaker.label))].name);
  const nameText = speaker.ordinal === undefined ? name : `${name} #${speaker.ordinal}`;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      {detailOpen === undefined ? (
        <span className={nameStyle}>{nameText}</span>
      ) : (
        <button
          type="button"
          aria-expanded={detailOpen}
          title={t("review.fleet.steps")}
          onClick={onToggleDetail}
          className={cn(nameStyle, "inline-flex items-center gap-0.5 rounded hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
        >
          {nameText}
          <ChevronRight className={cn("h-3 w-3 transition-transform", detailOpen && "rotate-90")} aria-hidden="true" />
        </button>
      )}
      {speaker.model ? (
        <span data-testid="fleet-chat-model" className="text-[11px] font-medium text-muted-foreground">
          {speaker.model}
        </span>
      ) : null}
    </p>
  );
}

function ReplyQuote({ reply, speaker }: { reply: ChatReply; speaker: ChatSpeaker }) {
  const t = useT();
  const role = agentRole(speaker.label);
  const quotedName = role.kind === "verification" ? t("review.fleet.agent.review", { dimension: t(`analysis.dimension.${role.dimension}`) }) : null;
  const quote = (
    <>
      {quotedName ? <span className="block text-[11px] font-semibold text-foreground/80">{quotedName}</span> : null}
      <span className="block text-muted-foreground [overflow-wrap:anywhere]">{reply.title}</span>
    </>
  );
  const quoteStyle = "my-1 block w-full rounded-md border-l-[3px] border-sky-400/70 bg-background/60 px-2 py-1 text-left";
  const { messageId } = reply;
  if (!messageId) return <div className={quoteStyle}>{quote}</div>;
  return (
    <button
      type="button"
      aria-label={t("review.fleet.goToReply", { title: reply.title })}
      onClick={() => document.getElementById(chatEntryDomId(messageId))?.scrollIntoView({ block: "center", behavior: "smooth" })}
      className={cn(quoteStyle, "hover:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
    >
      {quote}
    </button>
  );
}

function ReadingBody({ reading }: { reading: AgentReading }) {
  const t = useT();
  switch (reading.kind) {
    case "findings":
      if (reading.titles.length === 0) return <p>{t("review.fleet.noFindings")}</p>;
      return (
        <div className="min-w-0">
          <p className="font-medium">{t(reading.titles.length === 1 ? "review.fleet.findingsCount.one" : "review.fleet.findingsCount.other", { n: reading.titles.length })}</p>
          <ul className="list-disc pl-4 [overflow-wrap:anywhere]">
            {reading.titles.map((title, index) => <li key={`${index}-${title}`}>{title}</li>)}
          </ul>
        </div>
      );
    case "verdict":
      return (
        <div className="min-w-0">
          <p className={cn("font-semibold", reading.confirmed ? "text-amber-300" : "text-emerald-300")}>
            {t(reading.confirmed ? "review.fleet.confirmed" : "review.fleet.refuted")}
          </p>
          {reading.evidence ? <Speech text={reading.evidence} /> : null}
        </div>
      );
    case "text":
      return <Speech text={reading.text} />;
  }
}

function Speech({ text }: { text: string }) {
  const t = useT();
  const [expanded, setExpanded] = React.useState(false);
  const long = isLongSpeech(text);
  const collapsed = long && !expanded;
  return (
    <div className="min-w-0">
      <div
        data-testid="fleet-chat-speech"
        data-collapsed={collapsed}
        className={cn("min-w-0 [overflow-wrap:anywhere]", collapsed && "max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]")}
      >
        <Markdown text={text} />
      </div>
      {long ? (
        <button type="button" onClick={() => setExpanded(!expanded)} className="text-[11px] font-medium text-sky-400 hover:underline">
          {t(expanded ? "review.fleet.less" : "review.fleet.more")}
        </button>
      ) : null}
    </div>
  );
}

function fleetAgentName(label: string, t: Translate): string {
  const role = agentRole(label);
  switch (role.kind) {
    case "context":
      return t("review.fleet.agent.context");
    case "judge":
      return t("review.fleet.agent.judge");
    case "review":
      return t("review.fleet.agent.review", { dimension: t(`analysis.dimension.${role.dimension}`) });
    case "verification":
      return t("review.fleet.agent.verification", { dimension: t(`analysis.dimension.${role.dimension}`) });
    case "other":
      return role.label;
  }
}

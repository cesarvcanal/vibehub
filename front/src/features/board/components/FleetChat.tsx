import * as React from "react";
import { BookCheck, Bot, Braces, Bug, ChevronRight, FlaskConical, Gauge, Scale, ShieldCheck, Telescope, type LucideIcon } from "lucide-react";
import type { AnalysisDimension } from "@/api/types";
import { Markdown } from "@/features/board/components/ChatView";
import { TypingDots } from "@/features/board/components/PeerTypingIndicator";
import {
  chatClockText, isLongSpeech, type ChatReply, type ChatSpeaker, type FleetChatEntry, type ModelFamily,
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

const MODEL_CHIP_STYLE: Record<ModelFamily, string> = {
  opus: "border-violet-400/40 bg-violet-400/10 text-violet-200",
  sonnet: "border-sky-400/40 bg-sky-400/10 text-sky-200",
  haiku: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  other: "border-border/60 bg-muted/40 text-muted-foreground",
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

function chatEntryDomId(entryId: string): string {
  return `fleet-chat-${entryId}`;
}

export type AgentDetail = (agentId: string, running: boolean) => React.ReactNode;

export function FleetChat({ entries, label, agentDetail }: { entries: FleetChatEntry[]; label: string; agentDetail?: AgentDetail }) {
  const [openEntryIds, setOpenEntryIds] = React.useState<ReadonlySet<string>>(new Set());
  const toggleEntry = (entryId: string) => {
    const next = new Set(openEntryIds);
    if (!next.delete(entryId)) next.add(entryId);
    setOpenEntryIds(next);
  };
  return (
    <ol aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      {entries.map((entry, index) => {
        const continues = entries[index - 1]?.speaker.agentId === entry.speaker.agentId;
        const detail = agentDetail && openEntryIds.has(entry.id) ? agentDetail(entry.speaker.agentId, entry.kind === "typing") : null;
        return (
          <li key={entry.id} id={chatEntryDomId(entry.id)} className={cn("flex min-w-0 items-end gap-2", !continues && index > 0 && "mt-1")}>
            {continues ? <span className="w-7 shrink-0" aria-hidden="true" /> : <Avatar speaker={entry.speaker} />}
            <ChatBubble
              entry={entry}
              showSpeaker={!continues}
              detailOpen={agentDetail ? openEntryIds.has(entry.id) : undefined}
              onToggleDetail={() => toggleEntry(entry.id)}
            >
              {detail}
            </ChatBubble>
          </li>
        );
      })}
    </ol>
  );
}

function Avatar({ speaker }: { speaker: ChatSpeaker }) {
  const role = agentRole(speaker.label);
  const tone = agentTone(role);
  const style = TONE_STYLE[tone];
  const isVerification = role.kind === "verification";
  const Icon = style.icon;
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      data-verification={isVerification}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full",
        isVerification ? cn("border-2 bg-background", style.outline) : cn("text-background", style.solid),
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
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
      {entry.kind === "stopped" ? <p className="text-destructive">{t("review.fleet.stopped")}</p> : null}
      {children}
    </article>
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
        <span data-testid="fleet-chat-model" className={cn("rounded border px-1 text-[10px] font-medium leading-4", MODEL_CHIP_STYLE[speaker.family])}>
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

import * as React from "react";
import { Markdown } from "@/features/board/components/ChatView";
import { TypingDots } from "@/features/board/components/PeerTypingIndicator";
import {
  chatClockText, isLongSpeech, type ChatReply, type ChatSpeaker, type FleetChatEntry, type ModelFamily,
} from "@/features/board/lib/fleetChat";
import { agentRole, type AgentReading } from "@/features/board/lib/reviewFleet";
import { useT, type Translate } from "@/i18n";
import { cn } from "@/lib/utils";

const ENTRY_TEST_ID: Record<FleetChatEntry["kind"], string> = {
  message: "fleet-chat-message",
  typing: "fleet-chat-typing",
  stopped: "fleet-chat-stopped",
};

const FAMILY_STYLE: Record<ModelFamily, { avatar: string; name: string; initial: string }> = {
  opus: { avatar: "bg-violet-400", name: "text-violet-300", initial: "O" },
  sonnet: { avatar: "bg-sky-400", name: "text-sky-300", initial: "S" },
  haiku: { avatar: "bg-emerald-400", name: "text-emerald-300", initial: "H" },
  other: { avatar: "bg-muted-foreground", name: "text-foreground/90", initial: "" },
};

function chatEntryDomId(entryId: string): string {
  return `fleet-chat-${entryId}`;
}

export function FleetChat({ entries, label }: { entries: FleetChatEntry[]; label: string }) {
  return (
    <ol aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      {entries.map((entry, index) => {
        const continues = entries[index - 1]?.speaker.agentId === entry.speaker.agentId;
        return (
          <li key={entry.id} id={chatEntryDomId(entry.id)} className={cn("flex min-w-0 items-end gap-2", !continues && index > 0 && "mt-1")}>
            {continues ? <span className="w-7 shrink-0" aria-hidden="true" /> : <Avatar speaker={entry.speaker} />}
            <ChatBubble entry={entry} showSpeaker={!continues} />
          </li>
        );
      })}
    </ol>
  );
}

function Avatar({ speaker }: { speaker: ChatSpeaker }) {
  const style = FAMILY_STYLE[speaker.family];
  const initial = style.initial || speaker.label.trim().charAt(0).toUpperCase();
  return (
    <span aria-hidden="true" className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-background", style.avatar)}>
      {initial}
    </span>
  );
}

function ChatBubble({ entry, showSpeaker }: { entry: FleetChatEntry; showSpeaker: boolean }) {
  const t = useT();
  return (
    <article
      data-testid={ENTRY_TEST_ID[entry.kind]}
      className={cn("min-w-0 max-w-[88%] rounded-xl bg-muted/50 px-2.5 py-1.5 text-xs leading-relaxed", showSpeaker ? "rounded-bl-sm" : "rounded-l-sm")}
    >
      {showSpeaker ? <SpeakerLine speaker={entry.speaker} /> : null}
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
      {entry.kind === "stopped" ? (
        <p className="text-destructive [overflow-wrap:anywhere]">{entry.error ? t("review.fleet.failed", { error: entry.error }) : t("review.fleet.stopped")}</p>
      ) : null}
    </article>
  );
}

function SpeakerLine({ speaker }: { speaker: ChatSpeaker }) {
  const t = useT();
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className={cn("font-semibold", FAMILY_STYLE[speaker.family].name)}>{fleetAgentName(speaker.label, t)}</span>
      {speaker.model ? <span className="text-[11px] text-muted-foreground">{speaker.model}</span> : null}
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

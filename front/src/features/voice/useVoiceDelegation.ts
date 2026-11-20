import * as React from "react";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { apiErrorMessage } from "@/lib/apiError";
import type { VoiceCall } from "./useVoiceCall";
import type { VoiceToolCall } from "./liveVoice";
import { agentContext } from "./voiceContext";
import {
  ASK_WITHOUT_REQUEST,
  DELEGATION_NOT_SENT,
  DELEGATION_SLOW,
  DELEGATION_SLOW_MS,
  DELEGATION_STARTED,
  agentAnswerForVoice,
  delegationReply,
  delegationRequest,
  isAgentAnswer,
} from "./voiceDelegation";

export const ASK_AGENT_TOOL = "ask_card_agent";

export interface VoiceActionCall {
  callId: string;
  name: string;
  arguments: string;
}

interface PendingAsk {
  asked: string;
  request: string;
  slowTimer: ReturnType<typeof setTimeout>;
}

export interface UseVoiceDelegationOptions {
  call: Pick<VoiceCall, "snap" | "onToolCall" | "answerToolCall" | "appendContext" | "announceContext">;
  rows: SdkRow[];
  /** A turn of the agent is running or about to (a message just went). */
  turnRunning: boolean;
  sendUrgentToAgent: (text: string) => void;
  runAction: (call: VoiceActionCall) => Promise<unknown>;
}

function askedOfAgent(argumentsJson: string): string | null {
  try {
    const { request } = JSON.parse(argumentsJson) as { request?: unknown };
    return typeof request === "string" && request.trim() ? request.trim() : null;
  } catch {
    return null;
  }
}

export function useVoiceDelegation({ call, rows, turnRunning, sendUrgentToAgent, runAction }: UseVoiceDelegationOptions): void {
  const { onToolCall, answerToolCall, appendContext, announceContext } = call;
  const live = call.snap.state === "live";
  const sendRef = React.useRef(sendUrgentToAgent);
  sendRef.current = sendUrgentToAgent;
  const runActionRef = React.useRef(runAction);
  runActionRef.current = runAction;
  // A ref, not state: a result must go once, and two effect runs before a re-render would send it twice.
  const pending = React.useRef<PendingAsk[]>([]);
  const [asksSent, setAsksSent] = React.useState(0);

  React.useEffect(() => {
    const askAgent = (toolCall: VoiceToolCall) => {
      const asked = askedOfAgent(toolCall.argumentsJson);
      if (!asked) {
        answerToolCall(toolCall.callId, { error: ASK_WITHOUT_REQUEST });
        return;
      }
      const request = delegationRequest(asked, toolCall.turns);
      try {
        sendRef.current(request);
      } catch {
        answerToolCall(toolCall.callId, { error: DELEGATION_NOT_SENT });
        return;
      }
      answerToolCall(toolCall.callId, { ok: true, status: DELEGATION_STARTED });
      const slowTimer = setTimeout(() => appendContext(DELEGATION_SLOW), DELEGATION_SLOW_MS);
      pending.current.push({ asked, request, slowTimer });
      setAsksSent((count) => count + 1);
    };
    return onToolCall((toolCall) => {
      if (toolCall.name === ASK_AGENT_TOOL) {
        askAgent(toolCall);
        return;
      }
      void runActionRef.current({ callId: toolCall.callId, name: toolCall.name, arguments: toolCall.argumentsJson }).then(
        (output) => answerToolCall(toolCall.callId, output),
        (err: unknown) => answerToolCall(toolCall.callId, { error: apiErrorMessage(err) }),
      );
    });
  }, [onToolCall, answerToolCall, appendContext]);

  React.useEffect(
    () => () => {
      for (const { slowTimer } of pending.current) clearTimeout(slowTimer);
    },
    [],
  );

  const told = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    if (!live) {
      told.current = null;
      for (const { slowTimer } of pending.current) clearTimeout(slowTimer);
      pending.current = [];
      return;
    }
    // What the agent had said before the call is already in the session's instructions.
    told.current ??= new Set(rows.filter(isAgentAnswer).map((row) => row.text));
    const known = told.current;
    const held = new Set<string>();
    const stillWaiting: PendingAsk[] = [];
    for (const ask of pending.current) {
      const reply = delegationReply(rows, ask.request, turnRunning);
      if (reply.state === "waiting") {
        stillWaiting.push(ask);
        for (const text of reply.answers) held.add(text);
        continue;
      }
      clearTimeout(ask.slowTimer);
      announceContext(agentAnswerForVoice(ask.asked, reply.state === "answered" ? reply.text : null));
      for (const text of reply.answers) known.add(text);
    }
    pending.current = stillWaiting;
    for (const row of rows) {
      if (!isAgentAnswer(row) || known.has(row.text) || held.has(row.text)) continue;
      known.add(row.text);
      appendContext(agentContext(row.text));
    }
  }, [rows, turnRunning, live, asksSent, appendContext, announceContext]);
}

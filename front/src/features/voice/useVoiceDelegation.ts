import * as React from "react";
import type { SdkQuestionAnswer, SdkRow } from "@/features/board/lib/sdkChat";
import { apiErrorMessage } from "@/lib/apiError";
import type { VoiceActionCall } from "@/api/types";
import type { VoiceCall } from "./useVoiceCall";
import type { VoiceToolCall } from "./liveVoice";
import { agentContext } from "./voiceContext";
import {
  ASK_WITHOUT_REQUEST,
  DELEGATION_INTERRUPTED,
  DELEGATION_NOT_SENT,
  DELEGATION_QUEUED,
  DELEGATION_RECOVERY_MS,
  DELEGATION_RESENT,
  DELEGATION_SLOW,
  DELEGATION_SLOW_MS,
  DELEGATION_STARTED,
  DELEGATION_STOPPED,
  NO_RECOVERY,
  aboutRequestForVoice,
  agentAnswerForVoice,
  askedOfAgent,
  delegationReply,
  delegationRequest,
  delegationRetryRequest,
  isAgentAnswer,
  nextRecoveryStep,
  type DelegationAnchor,
  type DelegationRecovery,
} from "./voiceDelegation";
import { QUESTION_ANSWER_SENT, openQuestion, questionForVoice, voiceAnswers, type OpenQuestion } from "./voiceQuestion";
import type { VoiceTurn } from "./voiceTurns";

const ASK_AGENT_TOOL = "ask_card_agent";

export type AgentDelivery = "sent" | "queued";

interface PendingAsk {
  asked: string;
  turns: VoiceTurn[];
  anchor: DelegationAnchor;
  slowTimer: ReturnType<typeof setTimeout>;
  recovery: DelegationRecovery;
}

export interface UseVoiceDelegationOptions {
  call: Pick<VoiceCall, "snap" | "onToolCall" | "answerToolCall" | "appendContext" | "announceContext">;
  rows: SdkRow[];
  /** A turn of the agent is running or about to (a message just went). */
  turnRunning: boolean;
  deliverToAgent: (text: string) => AgentDelivery;
  runAction: (call: VoiceActionCall) => Promise<unknown>;
  answerQuestion: (questionId: string, answers: SdkQuestionAnswer[]) => boolean;
}

export interface VoiceDelegation {
  stopPendingAsks: () => void;
}

export function useVoiceDelegation({ call, rows, turnRunning, deliverToAgent, runAction, answerQuestion }: UseVoiceDelegationOptions): VoiceDelegation {
  const { onToolCall, answerToolCall, appendContext, announceContext } = call;
  const live = call.snap.state === "live";
  const deliverRef = React.useRef(deliverToAgent);
  deliverRef.current = deliverToAgent;
  const runActionRef = React.useRef(runAction);
  runActionRef.current = runAction;
  const answerQuestionRef = React.useRef(answerQuestion);
  answerQuestionRef.current = answerQuestion;
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // A ref, not state: a result must go once, and two effect runs before a re-render would send it twice.
  const pending = React.useRef<PendingAsk[]>([]);
  const [asksSent, setAsksSent] = React.useState(0);
  const recoveryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recoveryClock, setRecoveryClock] = React.useState(0);

  React.useEffect(() => {
    const sendRequest = (asked: string, turns: VoiceTurn[]): HandOver => {
      const request = delegationRequest(asked, turns);
      const delivery = deliverRef.current(request);
      return { state: "sent", anchor: { request }, status: delivery === "queued" ? DELEGATION_QUEUED : DELEGATION_STARTED };
    };
    const answerOpenQuestion = (question: OpenQuestion, turns: VoiceTurn[]): HandOver => {
      const answers = voiceAnswers(question.questions, turns);
      if (!answers) return { state: "unheard" };
      return answerQuestionRef.current(question.id, answers)
        ? { state: "sent", anchor: { questionId: question.id }, status: QUESTION_ANSWER_SENT }
        : { state: "not_sent" };
    };
    const askAgent = (toolCall: VoiceToolCall) => {
      const asked = askedOfAgent(toolCall.argumentsJson);
      if (!asked) {
        answerToolCall(toolCall.callId, { error: ASK_WITHOUT_REQUEST });
        return;
      }
      const question = openQuestion(rowsRef.current);
      const handOver = question ? answerOpenQuestion(question, toolCall.turns) : sendRequest(asked, toolCall.turns);
      if (handOver.state !== "sent") {
        answerToolCall(toolCall.callId, { error: handOver.state === "unheard" ? ASK_WITHOUT_REQUEST : DELEGATION_NOT_SENT });
        return;
      }
      answerToolCall(toolCall.callId, { ok: true, status: handOver.status });
      const slowTimer = setTimeout(() => appendContext(DELEGATION_SLOW), DELEGATION_SLOW_MS);
      const choiceHasNoRequestToResend = question !== null;
      const recovery = choiceHasNoRequestToResend ? { ...NO_RECOVERY, resent: true } : NO_RECOVERY;
      pending.current.push({ asked, turns: toolCall.turns, anchor: handOver.anchor, slowTimer, recovery });
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

  const clearPending = React.useCallback((): void => {
    for (const { slowTimer } of pending.current) clearTimeout(slowTimer);
    pending.current = [];
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
  }, []);

  React.useEffect(() => clearPending, [clearPending]);

  const stopPendingAsks = React.useCallback((): void => {
    for (const { asked } of pending.current) appendContext(aboutRequestForVoice(asked, DELEGATION_STOPPED));
    clearPending();
  }, [appendContext, clearPending]);

  const told = React.useRef<Set<string> | null>(null);
  const readQuestions = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!live) {
      told.current = null;
      readQuestions.current.clear();
      clearPending();
      return;
    }
    // What the agent had said before the call is already in the session's instructions.
    told.current ??= new Set(rows.filter(isAgentAnswer).map((row) => row.text));
    const known = told.current;
    const held = new Set<string>();
    const stillWaiting: PendingAsk[] = [];
    const now = Date.now();
    for (const ask of pending.current) {
      const reply = delegationReply(rows, ask.anchor, turnRunning);
      for (const text of reply.answers) held.add(text);
      const step = nextRecoveryStep(reply, ask.recovery, now);
      switch (step.kind) {
        case "wait":
          stillWaiting.push({ ...ask, recovery: step.recovery });
          break;
        case "hold":
          if (step.tell) appendContext(aboutRequestForVoice(ask.asked, DELEGATION_INTERRUPTED));
          stillWaiting.push({ ...ask, recovery: step.recovery });
          break;
        case "resend": {
          const retry = delegationRetryRequest(ask.asked, ask.turns);
          deliverRef.current(retry);
          appendContext(aboutRequestForVoice(ask.asked, DELEGATION_RESENT));
          stillWaiting.push({ ...ask, anchor: { request: retry }, recovery: step.recovery });
          break;
        }
        case "answered":
          clearTimeout(ask.slowTimer);
          announceContext(agentAnswerForVoice(ask.asked, step.text));
          for (const text of reply.answers) known.add(text);
          break;
        case "give_up":
          clearTimeout(ask.slowTimer);
          announceContext(aboutRequestForVoice(ask.asked, step.note));
          break;
      }
    }
    pending.current = stillWaiting;
    const question = openQuestion(rows);
    if (question && !readQuestions.current.has(question.id) && announceContext(questionForVoice(question.questions))) {
      readQuestions.current.add(question.id);
      const asking = pending.current.at(-1);
      if (asking) {
        clearTimeout(asking.slowTimer);
        pending.current = pending.current.slice(0, -1);
        for (const text of delegationReply(rows, asking.anchor, true).answers) known.add(text);
      }
    }
    for (const row of rows) {
      if (!isAgentAnswer(row) || known.has(row.text) || held.has(row.text)) continue;
      known.add(row.text);
      appendContext(agentContext(row.text));
    }
    if (recoveryTimer.current) clearTimeout(recoveryTimer.current);
    const deadlines = pending.current.flatMap(({ recovery }) => (recovery.stalledSince === null ? [] : [recovery.stalledSince + DELEGATION_RECOVERY_MS]));
    recoveryTimer.current = deadlines.length === 0
      ? null
      : setTimeout(() => setRecoveryClock((tick) => tick + 1), Math.max(0, Math.min(...deadlines) - now));
  }, [rows, turnRunning, live, asksSent, recoveryClock, appendContext, announceContext, clearPending]);

  return { stopPendingAsks };
}

type HandOver = { state: "sent"; anchor: DelegationAnchor; status: string } | { state: "unheard" } | { state: "not_sent" };

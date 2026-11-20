import * as React from "react";
import type { SdkQuestionAnswer, SdkRow } from "@/features/board/lib/sdkChat";
import { apiErrorMessage } from "@/lib/apiError";
import type { VoiceActionCall } from "@/api/types";
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
  askedOfAgent,
  delegationReply,
  delegationRequest,
  isAgentAnswer,
  type DelegationAnchor,
} from "./voiceDelegation";
import { QUESTION_ANSWER_SENT, openQuestion, questionForVoice, voiceAnswers, type OpenQuestion } from "./voiceQuestion";
import type { VoiceTurn } from "./voiceTurns";

const ASK_AGENT_TOOL = "ask_card_agent";

interface PendingAsk {
  asked: string;
  anchor: DelegationAnchor;
  slowTimer: ReturnType<typeof setTimeout>;
}

export interface UseVoiceDelegationOptions {
  call: Pick<VoiceCall, "snap" | "onToolCall" | "answerToolCall" | "appendContext" | "announceContext">;
  rows: SdkRow[];
  /** A turn of the agent is running or about to (a message just went). */
  turnRunning: boolean;
  sendUrgentToAgent: (text: string) => void;
  runAction: (call: VoiceActionCall) => Promise<unknown>;
  answerQuestion: (questionId: string, answers: SdkQuestionAnswer[]) => boolean;
}

export function useVoiceDelegation({ call, rows, turnRunning, sendUrgentToAgent, runAction, answerQuestion }: UseVoiceDelegationOptions): void {
  const { onToolCall, answerToolCall, appendContext, announceContext } = call;
  const live = call.snap.state === "live";
  const sendRef = React.useRef(sendUrgentToAgent);
  sendRef.current = sendUrgentToAgent;
  const runActionRef = React.useRef(runAction);
  runActionRef.current = runAction;
  const answerQuestionRef = React.useRef(answerQuestion);
  answerQuestionRef.current = answerQuestion;
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // A ref, not state: a result must go once, and two effect runs before a re-render would send it twice.
  const pending = React.useRef<PendingAsk[]>([]);
  const [asksSent, setAsksSent] = React.useState(0);

  React.useEffect(() => {
    const sendRequest = (asked: string, turns: VoiceTurn[]): HandOver => {
      const request = delegationRequest(asked, turns);
      try {
        sendRef.current(request);
      } catch {
        return { state: "not_sent" };
      }
      return { state: "sent", anchor: { request } };
    };
    const answerOpenQuestion = (question: OpenQuestion, turns: VoiceTurn[]): HandOver => {
      const answers = voiceAnswers(question.questions, turns);
      if (!answers) return { state: "unheard" };
      return answerQuestionRef.current(question.id, answers) ? { state: "sent", anchor: { questionId: question.id } } : { state: "not_sent" };
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
      answerToolCall(toolCall.callId, { ok: true, status: question ? QUESTION_ANSWER_SENT : DELEGATION_STARTED });
      const slowTimer = setTimeout(() => appendContext(DELEGATION_SLOW), DELEGATION_SLOW_MS);
      pending.current.push({ asked, anchor: handOver.anchor, slowTimer });
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
  const readQuestions = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!live) {
      told.current = null;
      readQuestions.current.clear();
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
      const reply = delegationReply(rows, ask.anchor, turnRunning);
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
  }, [rows, turnRunning, live, asksSent, appendContext, announceContext]);
}

type HandOver = { state: "sent"; anchor: DelegationAnchor } | { state: "unheard" } | { state: "not_sent" };

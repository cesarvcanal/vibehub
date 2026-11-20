import * as React from "react";
import type { SdkQuestionAnswer, SdkRow } from "@/features/board/lib/sdkChat";
import type { VoiceCall } from "./useVoiceCall";
import { agentContext } from "./voiceContext";
import {
  DELEGATION_NOT_SENT,
  DELEGATION_SILENT,
  DELEGATION_SLOW,
  DELEGATION_SLOW_MS,
  DELEGATION_STARTED,
  DELEGATION_UNHEARD,
  delegationReply,
  delegationRequest,
  isAgentAnswer,
  type DelegationAnchor,
} from "./voiceDelegation";
import { QUESTION_ANSWER_SENT, openQuestion, questionForVoice, voiceAnswers, type OpenQuestion } from "./voiceQuestion";
import type { VoiceTurn } from "./voiceTurns";

/**
 * THE VOICE AND THE CARD'S AGENT, during a call in the chat — the person codes by talking.
 *
 * - The voice is told at once that the work started; when the agent's turn on it ends, its last
 *   answer goes back on that delegation to be SAID. Each delegation gets exactly one result, even
 *   when the message could not go — GPT-Live waits for it otherwise.
 * - Every other answer the agent gives during the call reaches the voice as quiet context. Keyed
 *   by TEXT: a reconnect replays the thread with new row ids, and must not re-tell the voice what it
 *   already knows.
 */

interface PendingDelegation {
  id: string;
  anchor: DelegationAnchor;
  slowTimer: ReturnType<typeof setTimeout>;
}

export interface UseVoiceDelegationOptions {
  call: Pick<VoiceCall, "snap" | "onDelegation" | "answerDelegation" | "appendContext" | "announceContext">;
  rows: SdkRow[];
  /** A turn of the agent is running or about to (a message just went). */
  turnRunning: boolean;
  sendUrgentToAgent: (text: string) => void;
  answerQuestion: (questionId: string, answers: SdkQuestionAnswer[]) => boolean;
}

export function useVoiceDelegation({ call, rows, turnRunning, sendUrgentToAgent, answerQuestion }: UseVoiceDelegationOptions): void {
  const { onDelegation, answerDelegation, appendContext, announceContext } = call;
  const live = call.snap.state === "live";
  const sendRef = React.useRef(sendUrgentToAgent);
  sendRef.current = sendUrgentToAgent;
  const answerQuestionRef = React.useRef(answerQuestion);
  answerQuestionRef.current = answerQuestion;
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  // A ref, not state: a result must go once, and two effect runs before a re-render would send it twice.
  const pending = React.useRef<PendingDelegation[]>([]);
  // Bumped when a delegation is taken, so the effect below looks at the chat again.
  const [taken, setTaken] = React.useState(0);

  React.useEffect(
    () =>
      onDelegation((id, turns) => {
        const question = openQuestion(rowsRef.current);
        const handOver = question ? answerOpenQuestion(answerQuestionRef.current, question, turns) : sendRequest(sendRef.current, turns);
        if (handOver.state !== "sent") {
          answerDelegation(id, handOver.state === "unheard" ? DELEGATION_UNHEARD : DELEGATION_NOT_SENT, "result");
          return;
        }
        answerDelegation(id, question ? QUESTION_ANSWER_SENT : DELEGATION_STARTED, "progress");
        const slowTimer = setTimeout(() => answerDelegation(id, DELEGATION_SLOW, "progress"), DELEGATION_SLOW_MS);
        pending.current.push({ id, anchor: handOver.anchor, slowTimer });
        setTaken((n) => n + 1);
      }),
    [onDelegation, answerDelegation],
  );

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
    const stillWaiting: PendingDelegation[] = [];
    for (const delegation of pending.current) {
      const reply = delegationReply(rows, delegation.anchor, turnRunning);
      if (reply.state === "waiting") {
        stillWaiting.push(delegation);
        for (const text of reply.answers) held.add(text);
        continue;
      }
      clearTimeout(delegation.slowTimer);
      answerDelegation(delegation.id, reply.state === "answered" ? reply.text : DELEGATION_SILENT, "result");
      for (const text of reply.answers) known.add(text);
    }
    pending.current = stillWaiting;
    const question = openQuestion(rows);
    if (question && !readQuestions.current.has(question.id)) {
      const spokenQuestion = questionForVoice(question.questions);
      const asking = pending.current.at(-1);
      const read = asking ? answerDelegation(asking.id, spokenQuestion, "result") : announceContext(spokenQuestion);
      if (read) readQuestions.current.add(question.id);
      if (read && asking) {
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
  }, [rows, turnRunning, live, taken, answerDelegation, appendContext, announceContext]);
}

type HandOver = { state: "sent"; anchor: DelegationAnchor } | { state: "unheard" } | { state: "not_sent" };

function sendRequest(send: UseVoiceDelegationOptions["sendUrgentToAgent"], turns: VoiceTurn[]): HandOver {
  const request = delegationRequest(turns);
  if (!request) return { state: "unheard" };
  try {
    send(request);
  } catch {
    return { state: "not_sent" };
  }
  return { state: "sent", anchor: { request } };
}

function answerOpenQuestion(answer: UseVoiceDelegationOptions["answerQuestion"], question: OpenQuestion, turns: VoiceTurn[]): HandOver {
  const answers = voiceAnswers(question.questions, turns);
  if (!answers) return { state: "unheard" };
  return answer(question.id, answers) ? { state: "sent", anchor: { questionId: question.id } } : { state: "not_sent" };
}

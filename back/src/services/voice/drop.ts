import { z } from "zod";
import { VoiceLiveError } from "./live.js";

const PEER_STATES = ["new", "connecting", "connected", "disconnected", "failed", "closed"] as const;
const ICE_STATES = ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"] as const;
const CHANNEL_STATES = ["connecting", "open", "closing", "closed"] as const;

const nonNegativeInt = z.number().int().nonnegative();

const voiceDropSchema = z.object({
  cause: z.enum(["peer_failed", "channel_closed"]),
  sessionId: z.string().min(1).max(200).nullable(),
  liveForMs: nonNegativeInt,
  peer: z.enum(PEER_STATES).nullable(),
  ice: z.enum(ICE_STATES).nullable(),
  channel: z.enum(CHANNEL_STATES).nullable(),
  iceDisconnectedForMs: nonNegativeInt.nullable(),
  sentBytes: nonNegativeInt.nullable(),
  receivedBytes: nonNegativeInt.nullable(),
  lastInputAgoMs: nonNegativeInt.nullable(),
  lastOutputAgoMs: nonNegativeInt.nullable(),
  online: z.boolean(),
  hidden: z.boolean(),
}).strict();

export type VoiceDrop = z.infer<typeof voiceDropSchema>;

export function parseVoiceDrop(body: unknown): VoiceDrop {
  const parsed = voiceDropSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new VoiceLiveError(400, `invalid voice drop: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

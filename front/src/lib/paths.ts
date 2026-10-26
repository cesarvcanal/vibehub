/** Every route the shell knows about, in one place. */
export const Paths = {
  BOARD: "/",
  LOGIN: "/login",
  SETUP: "/setup",
  /** The GPT-Live voice mode POC — reachable by URL only, off unless the server enables it. */
  VOICE: "/voice",
  /** The living orb's calibration bench (V37 controls) — for developers, by URL only. */
  VOICE_LAB: "/voice/lab",
} as const;

export type Path = (typeof Paths)[keyof typeof Paths];

/** Every route the shell knows about, in one place. */
export const Paths = {
  BOARD: "/",
  LOGIN: "/login",
  SETUP: "/setup",
} as const;

export type Path = (typeof Paths)[keyof typeof Paths];

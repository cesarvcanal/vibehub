import { JsonStore } from "../../store/jsonStore.js";
import { dataPath } from "../../config/env.js";

/**
 * INSTALL SETTINGS — the handful of choices an operator makes once, in the wizard, and can revisit
 * later. Runner topology (local vs ssh) stays in env/config because it decides how the process
 * reaches Docker at boot; everything here is a product decision, not a deployment one.
 */

export interface GitIdentitySettings {
  name: string;
  email: string;
}

/**
 * How the SDK driver's permission gate behaves (only matters with `sdkDriver` on):
 *
 * - `"same-as-terminal"` — the native chat has EXACTLY the permission behaviour the Terminal tab of
 *   the same card already has: the runner is autonomous (bypassPermissions), so nothing escalates to
 *   the chat. One card, two views, ONE permission story — the maintainer's call for autonomous installs:
 *   consistency between the two interfaces, no extra restrictions in one of them.
 * - `"ask-sensitive"` — the driver's PreToolUse gate escalates the SENSITIVE set (rm -rf /
 *   force-push / deploy / secret reads) to Permitir/Negar buttons in the chat. Kept for scenarios
 *   where the chat is in less-trusted hands (shared members, phone-only review).
 */
export type SdkPermissionMode = "same-as-terminal" | "ask-sensitive";

const SDK_PERMISSION_MODES: readonly SdkPermissionMode[] = ["same-as-terminal", "ask-sensitive"];

export interface Settings {
  /** Identity the runner commits with. Defaults come from the connected GitHub account. */
  git: GitIdentitySettings;
  /**
   * Whether the agent runs without permission prompts inside the runner. True is the useful default
   * for an isolated container, but it is an explicit choice the wizard asks for.
   */
  autonomous: boolean;
  /** Display name for the default Claude profile (the one that is not a named account). */
  defaultAccountLabel: string | null;
  /** Set once the wizard has been completed, so it stops hijacking the router. */
  setupCompletedAt: string | null;
  transcribeLanguage: string | null;
  transcribeProofread: boolean;
  transcribeKeywords: string[];
  /**
   * MINUTES a card's terminal may sit idle before it is HIBERNATED: the session is killed and the
   * card stays exactly where it is on the board, marked cold. 0 turns the sweep off entirely.
   *
   * The default is three hours — long enough to survive a lunch and an afternoon of context
   * switching, short enough that what you abandoned yesterday is not still holding a Claude process
   * and pretending to be live work.
   */
  idleHibernateMinutes: number;
  /**
   * The NATIVE CHAT switch — on by default since 2026-08-31, when it graduated from the per-card
   * beta. With it on, the Chat tab of EVERY card runs over the Agent SDK "driver" (a headless,
   * structured stream-json process in the runner) instead of the tmux transcript reader; the
   * per-card `sdkChat` field became vestigial. With it off, every card uses the classic chat and
   * the `/api/cards/:id/sdk` websocket does not start. See `docs/sdk-driver.md`.
   */
  sdkDriver: boolean;
  /** Permission behaviour of the SDK driver's gate — see {@link SdkPermissionMode}. */
  sdkPermissionMode: SdkPermissionMode;
  /**
   * ON by default. A deploy of the panel restarts the back, and the SDK drivers (its children) die
   * with it — a turn in flight used to be lost in silence. With this on, the boot sweep finds the
   * interrupted turns (durable markers, see services/sdk/inflight.ts), writes a visible system line
   * in the card's chat and resumes the turn automatically — ONCE per turn, never in a loop. Off =
   * only the system line; the person resumes by hand.
   */
  sdkAutoResume: boolean;
  selfProjectId: string | null;
}

interface SettingsDoc { settings: Settings }

export const TRANSCRIBE_KEYWORDS_MAX = 100;
export const TRANSCRIBE_KEYWORD_MAX_CHARS = 60;
// external: a keyword with "<", ">", CR or LF makes the API reject the whole request (developers.openai.com/api/docs/guides/speech-to-text)
const KEYWORD_FORBIDDEN_RE = /[<>\r\n]/;

function normalizeTranscribeKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords) || !keywords.every((keyword): keyword is string => typeof keyword === "string")) {
    throw new Error("transcribeKeywords must be a list of terms");
  }
  const terms = keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword !== "");
  if (terms.length > TRANSCRIBE_KEYWORDS_MAX) throw new Error(`transcribeKeywords takes at most ${TRANSCRIBE_KEYWORDS_MAX} terms`);
  const invalidTerm = terms.find((term) => term.length > TRANSCRIBE_KEYWORD_MAX_CHARS || KEYWORD_FORBIDDEN_RE.test(term));
  if (invalidTerm !== undefined) {
    throw new Error(`transcribeKeywords: each term has at most ${TRANSCRIBE_KEYWORD_MAX_CHARS} characters, no line break, "<" or ">"`);
  }
  return terms;
}

const DEFAULTS: Settings = {
  git: { name: "vibehub", email: "vibehub@localhost" },
  autonomous: true,
  defaultAccountLabel: null,
  setupCompletedAt: null,
  transcribeLanguage: null,
  transcribeProofread: false,
  transcribeKeywords: [],
  idleHibernateMinutes: 180,
  sdkDriver: true,
  sdkPermissionMode: "same-as-terminal",
  sdkAutoResume: true,
  selfProjectId: null,
};

const store = new JsonStore<SettingsDoc>(
  dataPath("settings.json"),
  () => ({ settings: { ...DEFAULTS, git: { ...DEFAULTS.git } } }),
  (raw) => {
    const stored = (raw as SettingsDoc)?.settings ?? {};
    return {
      settings: {
        ...DEFAULTS,
        ...stored,
        git: { ...DEFAULTS.git, ...(stored as Settings).git },
      },
    };
  },
);

export async function getSettings(): Promise<Settings> {
  return (await store.load()).settings;
}

export interface SettingsPatch {
  git?: Partial<GitIdentitySettings>;
  autonomous?: boolean;
  defaultAccountLabel?: string | null;
  transcribeLanguage?: string | null;
  transcribeProofread?: boolean;
  transcribeKeywords?: string[];
  idleHibernateMinutes?: number;
  sdkDriver?: boolean;
  sdkPermissionMode?: SdkPermissionMode;
  sdkAutoResume?: boolean;
  selfProjectId?: string | null;
}

/** Validates and applies a partial update. Unknown fields are ignored, not merged blindly. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const git = patch.git;
  if (git?.name !== undefined && String(git.name).trim() === "") throw new Error("git name cannot be empty");
  // `local@host` is enough: git itself accepts a dotless host (`user@localhost`), and the seeded
  // default IS `vibehub@localhost` — a validator stricter than its own default bricks the whole
  // settings form, because the form resends the stored identity on every save.
  if (git?.email !== undefined && !/^[^@\s]+@[^@\s]+$/.test(String(git.email).trim())) {
    throw new Error("git email is not a valid address");
  }
  if (patch.autonomous !== undefined && typeof patch.autonomous !== "boolean") {
    throw new Error("autonomous must be a boolean");
  }
  if (patch.transcribeProofread !== undefined && typeof patch.transcribeProofread !== "boolean") {
    throw new Error("transcribeProofread must be a boolean");
  }
  if (patch.sdkDriver !== undefined && typeof patch.sdkDriver !== "boolean") {
    throw new Error("sdkDriver must be a boolean");
  }
  if (patch.sdkPermissionMode !== undefined && !SDK_PERMISSION_MODES.includes(patch.sdkPermissionMode)) {
    throw new Error("sdkPermissionMode must be 'same-as-terminal' or 'ask-sensitive'");
  }
  if (patch.sdkAutoResume !== undefined && typeof patch.sdkAutoResume !== "boolean") {
    throw new Error("sdkAutoResume must be a boolean");
  }
  if (patch.selfProjectId !== undefined && patch.selfProjectId !== null && (typeof patch.selfProjectId !== "string" || patch.selfProjectId.trim() === "")) {
    throw new Error("selfProjectId must be a project id, or null");
  }
  if (patch.transcribeLanguage !== undefined && patch.transcribeLanguage !== null) {
    if (!/^[a-z]{2}$/.test(String(patch.transcribeLanguage).trim())) {
      throw new Error("transcribeLanguage must be a two-letter ISO 639-1 code, or null");
    }
  }
  const transcribeKeywords = patch.transcribeKeywords === undefined ? undefined : normalizeTranscribeKeywords(patch.transcribeKeywords);
  if (patch.idleHibernateMinutes !== undefined) {
    const minutes = Number(patch.idleHibernateMinutes);
    // A week is the ceiling: past that the setting is not "hibernate late", it is "never", and
    // "never" already has a spelling (0).
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 7 * 24 * 60) {
      throw new Error("idleHibernateMinutes must be a whole number of minutes between 0 and 10080");
    }
  }
  return await store.mutate((doc) => {
    if (git?.name !== undefined) doc.settings.git.name = String(git.name).trim();
    if (git?.email !== undefined) doc.settings.git.email = String(git.email).trim();
    if (patch.autonomous !== undefined) doc.settings.autonomous = patch.autonomous;
    if (patch.defaultAccountLabel !== undefined) {
      const label = patch.defaultAccountLabel === null ? null : String(patch.defaultAccountLabel).trim();
      doc.settings.defaultAccountLabel = label === "" ? null : label;
    }
    if (patch.transcribeLanguage !== undefined) {
      doc.settings.transcribeLanguage = patch.transcribeLanguage === null ? null : String(patch.transcribeLanguage).trim();
    }
    if (patch.transcribeProofread !== undefined) {
      doc.settings.transcribeProofread = patch.transcribeProofread;
    }
    if (transcribeKeywords !== undefined) {
      doc.settings.transcribeKeywords = transcribeKeywords;
    }
    if (patch.sdkDriver !== undefined) {
      doc.settings.sdkDriver = patch.sdkDriver;
    }
    if (patch.sdkPermissionMode !== undefined) {
      doc.settings.sdkPermissionMode = patch.sdkPermissionMode;
    }
    if (patch.sdkAutoResume !== undefined) {
      doc.settings.sdkAutoResume = patch.sdkAutoResume;
    }
    if (patch.selfProjectId !== undefined) {
      doc.settings.selfProjectId = patch.selfProjectId === null ? null : patch.selfProjectId.trim();
    }
    if (patch.idleHibernateMinutes !== undefined) {
      doc.settings.idleHibernateMinutes = Number(patch.idleHibernateMinutes);
    }
    return doc.settings;
  });
}

/** Stamps the install as set up. Idempotent: the first timestamp wins. */
export async function markSetupCompleted(): Promise<Settings> {
  return await store.mutate((doc) => {
    doc.settings.setupCompletedAt ??= new Date().toISOString();
    return doc.settings;
  });
}

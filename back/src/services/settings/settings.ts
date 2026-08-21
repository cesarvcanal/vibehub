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
  /** ISO 639-1 hint for voice transcription ("pt", "en"…). Null = let Whisper detect. */
  transcribeLanguage: string | null;
}

interface SettingsDoc { settings: Settings }

const DEFAULTS: Settings = {
  git: { name: "vibehub", email: "vibehub@localhost" },
  autonomous: true,
  defaultAccountLabel: null,
  setupCompletedAt: null,
  transcribeLanguage: null,
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
}

/** Validates and applies a partial update. Unknown fields are ignored, not merged blindly. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const git = patch.git;
  if (git?.name !== undefined && String(git.name).trim() === "") throw new Error("git name cannot be empty");
  if (git?.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(git.email).trim())) {
    throw new Error("git email is not a valid address");
  }
  if (patch.autonomous !== undefined && typeof patch.autonomous !== "boolean") {
    throw new Error("autonomous must be a boolean");
  }
  if (patch.transcribeLanguage !== undefined && patch.transcribeLanguage !== null) {
    if (!/^[a-z]{2}$/.test(String(patch.transcribeLanguage).trim())) {
      throw new Error("transcribeLanguage must be a two-letter ISO 639-1 code, or null");
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

export function resetSettingsForTesting(): void {
  store.resetForTesting();
}

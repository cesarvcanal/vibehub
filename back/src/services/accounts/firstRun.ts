import { shQuote, assertSafeRemotePath } from "../../runtime/host.js";

/**
 * FIRST-RUN WALLS of Claude Code, taken down before the session starts.
 *
 * Claude keeps its per-profile state in `<CLAUDE_CONFIG_DIR>/.claude.json`. When that file has no
 * `hasCompletedOnboarding`, EVERY launch opens the setup wizard ("Choose the text style that looks
 * best with your terminal") — and when the cwd is not listed under `projects`, the launch stops on
 * the trust dialog ("Is this a project you created or one you trust?"). vibehub creates a fresh
 * profile per account and a fresh worktree per card, so both walls show up exactly where they make
 * no sense: opening a card of an account whose profile was never onboarded looked like installing
 * Claude from scratch, on a card that had been worked on for days.
 *
 * Neither wall carries a decision the user has not already made: the account was logged in through
 * the Accounts screen, and the worktree is a clone of the repository the user attached to the
 * project. So the seed states them: onboarding done, dark theme (the panel's terminal is dark) and
 * the card's own worktree trusted. Everything else in the file is left untouched.
 *
 * The seed is IDEMPOTENT and only rewrites the file when something is actually missing — so it
 * costs one short node run per session creation and, past the first time, changes nothing.
 */

/** The per-profile state file Claude Code reads at startup. */
export const CLAUDE_JSON = ".claude.json";

/** Path of a profile's `.claude.json`. PURE. */
export function claudeJsonPath(profileDir: string): string {
  return `${profileDir}/${CLAUDE_JSON}`;
}

/**
 * The node program that does the merge. One line, DOUBLE quotes only — it travels inside a
 * single-quoted shell argument. Writes through a temp file + rename so a concurrent reader never
 * sees a half-written config; the temp file carries the PID, because two cards of one account
 * opening together run two seeds on the same file.
 *
 * Only a MISSING or EMPTY file starts from `{}` — neither holds anything to lose. One that cannot be
 * read or parsed is left exactly as it is (exit 0): it may be Claude halfway through writing it, and
 * it holds the account's login, its MCP servers and every project's history — rewriting it as a
 * minimal seed erased all of that, while skipping the seed costs at most a wizard. Same rule as the
 * purge's `.claude.json` edit.
 */
const SEED_JS = [
  'const fs=require("fs"),f=process.argv[1],w=process.argv[2];',
  'let c={};try{const s=fs.readFileSync(f,"utf8");if(s.trim())c=JSON.parse(s)}catch(e){if(e.code!=="ENOENT")process.exit(0)}',
  "let d=0;",
  "if(c.hasCompletedOnboarding!==true){c.hasCompletedOnboarding=true;d=1}",
  'if(!c.theme){c.theme="dark";d=1}',
  "if(w){const p=c.projects||(c.projects={});const e=p[w]||(p[w]={});",
  "if(e.hasTrustDialogAccepted!==true){e.hasTrustDialogAccepted=true;d=1}}",
  'if(d){const t=f+".vibehub-tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(c,null,2),{mode:0o600});fs.renameSync(t,f)}',
].join("");

/**
 * ONE shell command that seeds the profile's `.claude.json`. `cwd` is a SHELL EXPRESSION, not a
 * value: the session command is built before tmux knows the directory, so the caller passes `"$PWD"`
 * (the session is created with `-c <worktree>`) — pass nothing for a profile-only seed, such as the
 * login terminal, where no project has to be trusted.
 *
 * Never fatal: a runner without node, or an unreadable file, must not stop a card from opening —
 * hence `|| true` and the silenced output. PURE.
 */
export function firstRunSeedCommand(profileDir: string, cwd?: string): string {
  assertSafeRemotePath(profileDir);
  const target = shQuote(claudeJsonPath(profileDir));
  return `node -e ${shQuote(SEED_JS)} ${target}${cwd ? ` ${cwd}` : ""} >/dev/null 2>&1 || true`;
}

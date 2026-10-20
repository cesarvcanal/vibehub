import { shQuote } from "../../runtime/host.js";
import { assertGitName, assertGitEmail } from "../../auth/userGit.js";
import { GH_TOKEN_DIR, assertCardFileId, ghTokenPath } from "../accounts/token.js";

/**
 * HOW A CARD'S IDENTITY IS ENFORCED INSIDE THE RUNNER — for every `git` and every `gh` the card
 * runs, not only the ones in its worktree.
 *
 * WHOSE identity it is gets decided elsewhere: the card's actor, the person who sent it the latest
 * order (board/actor.ts), resolved field by field (github/identity.ts). This file is the other half —
 * making every process of the card ACT as that person, processes already running included. Both
 * mechanisms read a per-card FILE at call time, because a process's environment is fixed when it is
 * born and can never follow an identity that changes mid-card.
 *
 *  - `git`: every card process is born with `GIT_CONFIG_COUNT/KEY_0/VALUE_0` = `include.path=<file>`,
 *    config at COMMAND scope — the strongest there is. It wins in the worktree AND in any other
 *    repository the agent touches (the `_repos/<repo>` clones, which used to commit as the install's
 *    global identity and push with the runner's own login). The file is rewritten on every author
 *    switch; one that does not exist yet is skipped by git without a word, so it can never cost a
 *    card its git.
 *  - `gh`: `/usr/local/bin/gh`, ahead of `/usr/bin` in PATH, is a wrapper that reads the card's token
 *    file on every call and execs the real gh. It replaces the `.bashrc` shim, which only a shell
 *    that sources `.bashrc` ever saw (never the native chat's Claude, a script or an MCP) and which
 *    runners provisioned before it never got: `gh pr create/review/merge` went out as the runner's
 *    ambient login — the org account.
 *
 * The credential is offered to github.com ONLY. The card's token is a GitHub token, and a helper
 * that answered every host would hand it to whatever server asked — any remote an agent clones.
 */

const GIT_DIR = "/root/.vibehub/git";
const GITHUB = "https://github.com";
/** Where the wrapper goes: ahead of the real one in every PATH a card gets. */
export const GH_WRAPPER_PATH = "/usr/local/bin/gh";
/** The real gh, as the runner setup installs it (the official apt package). */
export const REAL_GH_PATH = "/usr/bin/gh";
/** Tells OUR wrapper apart from a gh somebody installed at the same path — that one is never touched. */
const WRAPPER_MARKER = "VIBEHUB_GH_WRAPPER";

/** The per-card git config every git process of the card includes. THROWS on a bad id. PURE. */
export function cardGitConfigPath(cardId: string): string {
  return `${GIT_DIR}/${assertCardFileId(cardId)}.gitconfig`;
}

/** The environment that makes a card process include that file — fixed at spawn, as it can be. PURE. */
export function cardGitEnv(cardId: string): Array<[string, string]> {
  return [
    ["GIT_CONFIG_COUNT", "1"],
    ["GIT_CONFIG_KEY_0", "include.path"],
    ["GIT_CONFIG_VALUE_0", cardGitConfigPath(cardId)],
  ];
}

/** The git config key of the card's credential helper: github.com only. PURE. */
export const CARD_CREDENTIAL_KEY = `credential.${GITHUB}.helper`;

/** A credential helper that answers with the card's token file, READ ON EVERY CALL. PURE. */
export function cardCredentialHelper(cardId: string): string {
  const file = ghTokenPath(cardId);
  return `!f() { [ -s ${file} ] && echo username=x-access-token && echo "password=$(cat ${file})"; }; f`;
}

/**
 * Script lines that (re)write the card's git include: the commit author and — when the card has a
 * token — the credential helper, after a RESET of the helper list (`''`): git asks every helper it
 * collected, in config order, and the runner's own `gh auth git-credential` would otherwise answer
 * first. Without a token the credential is left alone: an install with no GitHub account keeps the
 * login it has today.
 *
 * Built in a temp file and RENAMED over the old one: a git running at that instant reads the old
 * file or the new one, never half of it. `git config --file` writes it, so quoting follows git's
 * own rules (a `#` in a name would start a comment in a hand-written file). PURE.
 */
export function writeCardGitConfigLines(
  cardId: string, identity: { name: string; email: string }, withToken: boolean,
): string[] {
  const file = cardGitConfigPath(cardId);
  const name = assertGitName(identity.name);
  const email = assertGitEmail(identity.email);
  const cfg = 'git config --file "$T"';
  return [
    `mkdir -p ${shQuote(GIT_DIR)}`,
    `T=$(mktemp ${shQuote(`${file}.XXXXXX`)})`,
    `${cfg} user.name ${shQuote(name)}`,
    `${cfg} user.email ${shQuote(email)}`,
    ...(withToken
      ? [
          `${cfg} --add ${CARD_CREDENTIAL_KEY} ''`,
          `${cfg} --add ${CARD_CREDENTIAL_KEY} ${shQuote(cardCredentialHelper(cardId))}`,
        ]
      : []),
    `mv -f "$T" ${shQuote(file)}`,
  ];
}

/** The `gh` wrapper's source (POSIX sh). The id is checked before it becomes a path. PURE. */
export function ghWrapperSource(): string {
  return [
    "#!/bin/sh",
    `# ${WRAPPER_MARKER} — written by vibehub (back/src/services/github/runnerIdentity.ts).`,
    "# Inside a card (VIBEHUB_CARD_ID set), gh acts as whoever sent that card its latest order: the",
    "# token is read from the card's file on EVERY call, so a change of author reaches a session that",
    "# is already running. Outside a card, or in a card with no token file, this is the plain gh.",
    'case "${VIBEHUB_CARD_ID:-}" in',
    "  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) ;;",
    `  *) f="${GH_TOKEN_DIR}/$VIBEHUB_CARD_ID.token"`,
    '     if [ -s "$f" ]; then GH_TOKEN="$(cat "$f")"; export GH_TOKEN; fi ;;',
    "esac",
    `exec ${REAL_GH_PATH} "$@"`,
    "",
  ].join("\n");
}

/**
 * Script lines that install the wrapper — idempotent and never fatal. Only over NOTHING or over an
 * older copy of itself (the marker): a gh somebody installed at that path is theirs, and with no real
 * gh to exec the wrapper would only break `gh`. Unchanged = nothing written; changed = temp file +
 * rename, so a card calling `gh` at that instant never runs half a script. PURE.
 */
export function installGhWrapperLines(): string[] {
  const src = shQuote(ghWrapperSource());
  const target = shQuote(GH_WRAPPER_PATH);
  return [
    `if [ -x ${shQuote(REAL_GH_PATH)} ] && { [ ! -e ${target} ] || grep -q ${WRAPPER_MARKER} ${target}; } &&` +
      ` ! printf '%s' ${src} | cmp -s - ${target}; then`,
    `  T=$(mktemp ${shQuote(`${GH_WRAPPER_PATH}.XXXXXX`)}) && printf '%s' ${src} > "$T" && chmod 755 "$T" &&` +
      ` mv -f "$T" ${target} || rm -f "$T"`,
    "fi",
  ];
}

import pty from "node-pty";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { hostExecutor, shQuote } from "../runtime/host.js";
import { config } from "../config/env.js";
import { assertAccountSlug } from "../services/board/registry.js";
import { profileDirFor, DEFAULT_ACCOUNT_SLUG } from "../services/accounts/profiles.js";
import { bridgePty } from "./session.js";
import { logger } from "../utils/logger.js";

/**
 * INTERACTIVE ACCOUNT LOGIN, from the screen.
 *
 * `claude /login` is a TUI: it prints an authorization URL and asks for the pasted code back. That
 * cannot be a form — but it CAN be a terminal we open for the person, already in the right profile,
 * so "log this account in" is a button instead of a shell incantation. The login writes the
 * refreshable credentials into the profile's `.credentials.json`, which is also what the usage
 * meter reads — so this one flow both keeps the account signed in and lights its usage bars up.
 *
 * The command is fixed and built from validated parts: the container from config, the profile dir
 * derived from a validated slug ("default" = the built-in profile), everything shell-quoted.
 */
export async function accountLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string } }>(
    "/api/accounts/:slug/login-terminal",
    { websocket: true, preHandler: requireSession },
    (socket, req) => {
      const raw = req.params.slug;
      const slug = raw === DEFAULT_ACCOUNT_SLUG ? undefined : assertAccountSlug(raw);
      const profileDir = profileDirFor(slug);
      const inner = "claude /login; echo; echo '--- login flow ended — you can close this panel ---'; exec bash";
      const line =
        `docker exec -it ${shQuote(config.runner.container)} ` +
        `env LANG=C.UTF-8 LC_ALL=C.UTF-8 CLAUDE_CONFIG_DIR=${shQuote(profileDir)} ` +
        `bash -lc ${shQuote(inner)}`;
      const { file, args } = hostExecutor().ptyCommand(line);
      const term = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 30,
        env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color" },
      });
      logger.info({ audit: true, action: "account.login.terminal", account: raw }, "interactive login terminal opened");
      bridgePty(socket, term, `login-${raw}`);
    },
  );
}

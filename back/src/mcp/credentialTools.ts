import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { credentialsForCard } from "../services/credentials/credentials.js";
import { fillCredential } from "../services/credentials/fill.js";

/**
 * COFRE TOOLS — how a card's agent signs into a website WITHOUT ever seeing the password.
 *
 * The agent references a credential BY NAME. `vibehub_credential_fill` reads the value from the
 * vault and types it into the card's OWN live Chromium over CDP, out of band; the response is only
 * `{ filled, fields }` — never the value. This is the whole point: a login happens, and the secret
 * never enters the model's context, the chat, the transcript or a log.
 */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ok({ error: (e as Error).message });

export function registerCredentialTools(server: McpServer, actor: string): void {
  server.registerTool(
    "vibehub_credential_list",
    {
      description:
        "List the credentials in the Cofre available to this card — NAMES and TYPES only, never any " +
        "value. Use it to discover what logins exist before you try to sign in somewhere: if the site " +
        "you need is in the list, fill it with vibehub_credential_fill; if it is NOT, ask the user to " +
        "add it in Settings → Cofre. NEVER ask for a password in the chat. `card` is YOUR OWN card id " +
        "(the $VIBEHUB_CARD_ID of this terminal).",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
      },
    },
    async (a) => {
      try {
        return ok({ credentials: await credentialsForCard(a.card) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_credential_fill",
    {
      description:
        "Sign in on the card's live browser using a named credential from the Cofre — WITHOUT the " +
        "password ever reaching you. vibehub reads the value from the vault and types it straight " +
        "into the fields over CDP; you get back only { filled, fields } (the field labels filled), " +
        "never a value. Point it at the login form: pass `userSelector`/`passSelector` when you know " +
        "them, otherwise it finds the password field and the username field near it on its own. Pass " +
        "`url` to navigate there first. If the credential is not in the Cofre it fails telling you to " +
        "have the user add it in Settings → Cofre — never ask for the password in the chat. `card` is " +
        "YOUR OWN card id ($VIBEHUB_CARD_ID); `credential` is the NAME from vibehub_credential_list.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        credential: z.string().describe("the credential NAME (from vibehub_credential_list) — never a value"),
        userSelector: z.string().optional().describe("CSS selector of the username field (optional; heuristic otherwise)"),
        passSelector: z.string().optional().describe("CSS selector of the password field (optional; heuristic otherwise)"),
        url: z.string().optional().describe("navigate the browser here before filling (optional)"),
      },
    },
    async (a) => {
      try {
        return ok(await fillCredential(a.card, a.credential, {
          userSelector: a.userSelector,
          passSelector: a.passSelector,
          url: a.url,
          by: actor,
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

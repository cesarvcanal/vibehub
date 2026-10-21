import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  credentialsForCard, generateCredential, PASSWORD_DEFAULT, PASSWORD_MAX, PASSWORD_MIN,
} from "../services/credentials/credentials.js";
import { fillCredential } from "../services/credentials/fill.js";
import { listCaptures, saveCaptureForCard } from "../services/credentials/capture.js";

/**
 * COFRE TOOLS — how a card's agent signs into a website WITHOUT ever seeing the password.
 *
 * The agent references a credential BY NAME. `vibehub_credential_fill` reads the value from the
 * vault and types it into the card's OWN live Chromium over CDP, out of band; the response is only
 * `{ filled, fields }` — never the value. This is the whole point: a login happens, and the secret
 * never enters the model's context, the chat, the transcript or a log.
 *
 * WRITES keep the same rule: an agent never hands vibehub a password. It either has vibehub GENERATE
 * one (`vibehub_credential_generate`) or saves a login its own card's browser captured
 * (`vibehub_credential_save_capture`) — and only when the owner opted the card's project in.
 */
/** What a write returns: the metadata, never a value. */
const view = (c: { id: string; name: string; type: string; createdAt: number }) =>
  ({ id: c.id, name: c.name, type: c.type, createdAt: c.createdAt });
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
        confirmSelector: z.string().optional().describe("CSS selector of a 'confirm password' field — the same secret is typed there too (optional)"),
        url: z.string().optional().describe("navigate the browser here before filling (optional)"),
      },
    },
    async (a) => {
      try {
        return ok(await fillCredential(a.card, a.credential, {
          userSelector: a.userSelector,
          passSelector: a.passSelector,
          confirmSelector: a.confirmSelector,
          url: a.url,
          by: actor,
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_credential_generate",
    {
      description:
        "Create a NEW credential in the Cofre with a strong random password that vibehub generates and " +
        "encrypts in the same call — you NEVER see it, and neither does the chat or a log. Use it when " +
        "you must create an account or set/rotate a password on a system: generate here, then type it " +
        "into the site's password (and confirm) fields with vibehub_credential_fill " +
        "(passSelector/confirmSelector) and submit. Pass `username` for a user+password login; omit it " +
        "for a lone secret (token). The name must be new — an existing credential is never overwritten. " +
        "Only works if the owner enabled agent writes for this card's project in Settings → Cofre; if " +
        "refused, tell the user that — NEVER ask for a password in the chat. Returns metadata only.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        name: z.string().describe("the new credential's NAME (2-40 chars: letters, digits, '_', '.', '-')"),
        username: z.string().optional().describe("login username (not secret); omit for a token-only credential"),
        length: z.number().int().min(PASSWORD_MIN).max(PASSWORD_MAX).optional()
          .describe(`password length (default ${PASSWORD_DEFAULT})`),
      },
    },
    async (a) => {
      try {
        const credential = await generateCredential(a.card, { name: a.name, username: a.username, length: a.length }, actor);
        return ok({ credential: view(credential), generated: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_credential_captures",
    {
      description:
        "List the logins YOUR card's browser captured on a form submit and that were not saved yet — " +
        "id, host, suggested name and username; never the password. Save one with " +
        "vibehub_credential_save_capture.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
      },
    },
    async (a) => {
      try {
        return ok({ captures: listCaptures(a.card) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "vibehub_credential_save_capture",
    {
      description:
        "Save a login your card's browser captured (from vibehub_credential_captures) as a named " +
        "credential in the Cofre. The password goes from vibehub's capture straight to the vault — you " +
        "pass only the capture id and a name. Same rules as vibehub_credential_generate: the name must " +
        "be new, and the owner must have enabled agent writes for this card's project.",
      inputSchema: {
        card: z.string().describe("your own card id — the $VIBEHUB_CARD_ID of this terminal"),
        captureId: z.string().describe("the capture id from vibehub_credential_captures"),
        name: z.string().optional().describe("credential NAME (default: the capture's suggested name)"),
      },
    },
    async (a) => {
      try {
        const credential = await saveCaptureForCard(a.card, a.captureId, a.name, actor);
        return ok({ credential: view(credential) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

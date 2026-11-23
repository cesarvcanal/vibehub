import * as registry from "../board/registry.js";
import { restartCard } from "../board/workspace.js";
import { DEFAULT_ACCOUNT_SLUG } from "../accounts/profiles.js";
import { appendHistory } from "./history.js";
import { startCardDriver } from "./headless.js";
import {
  SYSTEM_ORIGIN, driverTurnRunning, injectSystemTurn, onAccountTurnOutcome, type AccountTurnOutcome, type DriverSession,
} from "./manager.js";
import { logger } from "../../utils/logger.js";

export const ACCOUNT_FALLBACK_CONTINUE_TEXT =
  "A conta Claude deste card ficou sem limite de uso e o painel trocou para a conta reserva, com a mesma conversa. " +
  "Isto NÃO é uma notificação automática: é a ordem de continuar. Retome o último pedido de onde parou.";

export const ACCOUNT_CHAIN_EXHAUSTED_NOTE =
  "Todas as contas Claude da cadeia de reserva deste card estão sem limite. O card espera o limite renovar.";

export const ACCOUNT_FALLBACK_FAILED_NOTE =
  "A troca para a conta reserva não conseguiu abrir o chat. Mande uma mensagem para o agente seguir de onde parou.";

export interface AccountFallbackDeps {
  restartCard: (cardId: string) => Promise<unknown>;
  startDriver: (cardId: string) => Promise<DriverSession>;
}

const realDeps: AccountFallbackDeps = {
  restartCard: (cardId) => restartCard(cardId, "account-fallback"),
  startDriver: startCardDriver,
};

type Refusal = Extract<AccountTurnOutcome, { kind: "refused" }>;

function formatRenewal(renewsAt: number): string {
  return new Date(renewsAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

function refusalReason(from: string, refusal: Refusal): string {
  if (refusal.reason === "login") return `A conta ${from} não conseguiu entrar no Claude.`;
  if (refusal.renewsAt === undefined) return `A conta ${from} ficou sem limite de uso.`;
  return `A conta ${from} ficou sem limite até ${formatRenewal(refusal.renewsAt)}.`;
}

function switchNote(from: string, to: string, refusal: Refusal): string {
  return `${refusalReason(from, refusal)} Seguindo na conta ${to}.`;
}

function appendNote(cardId: string, text: string): Promise<void> {
  return appendHistory(cardId, { type: "system_note", text, at: Date.now() });
}

async function continueOnBackup(cardId: string, deps: AccountFallbackDeps): Promise<void> {
  await deps.restartCard(cardId);
  const session = await deps.startDriver(cardId);
  if (driverTurnRunning(cardId)) return;
  injectSystemTurn(session, ACCOUNT_FALLBACK_CONTINUE_TEXT, SYSTEM_ORIGIN, 0);
}

export async function switchRefusedCardAccount(
  cardId: string,
  refusal: Refusal,
  deps: AccountFallbackDeps = realDeps,
): Promise<"switched" | "exhausted" | "skipped"> {
  const card = await registry.getCard(cardId);
  const project = card ? await registry.getProject(card.projectId) : undefined;
  if (!card || !project) return "skipped";
  const switchingChain = (card.accountLoan?.exhausted.length ?? 0) > 0;
  if (refusal.reason === "login" && !switchingChain) return "skipped";
  const from = registry.effectiveAccountSlug(card, project) ?? DEFAULT_ACCOUNT_SLUG;
  const backupSwitch = await registry.switchCardToBackupAccount(cardId, {
    account: from,
    ...(refusal.renewsAt !== undefined ? { renewsAt: refusal.renewsAt } : {}),
  });
  if (backupSwitch.outcome === "superseded" || backupSwitch.outcome === "noBackup") return "skipped";
  if (backupSwitch.outcome === "exhausted") {
    await appendNote(cardId, ACCOUNT_CHAIN_EXHAUSTED_NOTE);
    logger.warn(
      { audit: true, action: "card.account.fallback.exhausted", card: card.worktreeSlug, exhausted: backupSwitch.exhausted },
      "every account of the backup chain is out of plan usage — the card waits for a renewal",
    );
    return "exhausted";
  }
  logger.info(
    { audit: true, action: "card.account.fallback", card: card.worktreeSlug, from: backupSwitch.from, to: backupSwitch.to, reason: refusal.reason },
    "card account refused the turn — switched to its backup account",
  );
  await appendNote(cardId, switchNote(backupSwitch.from, backupSwitch.to, refusal));
  try {
    await continueOnBackup(cardId, deps);
  } catch (err) {
    await appendNote(cardId, ACCOUNT_FALLBACK_FAILED_NOTE);
    logger.warn(
      { audit: true, action: "card.account.fallback.failed", card: card.worktreeSlug, to: backupSwitch.to, detail: (err as Error).message },
      "switched to the backup account but could not reopen the chat on it",
    );
  }
  return "switched";
}

export function watchAccountRefusals(deps: AccountFallbackDeps = realDeps): () => void {
  return onAccountTurnOutcome((cardId, outcome) => {
    const work = outcome.kind === "answered"
      ? registry.clearCardFallbackChain(cardId)
      : switchRefusedCardAccount(cardId, outcome, deps);
    void work.catch((err: unknown) => {
      logger.warn({ card: cardId, action: "card.account.fallback.error", detail: (err as Error).message }, "account fallback could not run");
    });
  });
}

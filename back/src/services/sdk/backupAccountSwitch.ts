import * as registry from "../board/registry.js";
import { restartCard } from "../board/workspace.js";
import { onCardAccountSwitchProbe } from "../board/agentState.js";
import { startCardDriver } from "./headless.js";
import {
  SYSTEM_ORIGIN, driverTurnRunning, emitCardSystemNote, injectSystemTurn, onAccountTurnOutcome,
  type AccountTurnOutcome, type DriverSession,
} from "./manager.js";
import { logger } from "../../utils/logger.js";

export const BACKUP_SWITCH_CONTINUE_TEXT =
  "A conta Claude deste card ficou sem limite de uso e o painel trocou de conta, com a mesma conversa. " +
  "Isto NÃO é uma notificação automática: é a ordem de continuar. Retome o último pedido de onde parou.";

export const BACKUP_CHAIN_EXHAUSTED_NOTE =
  "Todas as contas Claude da cadeia de reserva deste card estão sem limite ou sem login";

export const UNUSABLE_DEFAULT_ACCOUNT_NOTE =
  "A conta padrão do runner está na cadeia, mas este card não pode usá-la porque o projeto dele tem conta própria.";

export const BACKUP_SWITCH_FAILED_NOTE =
  "A troca para a conta reserva não conseguiu abrir o chat. Mande uma mensagem para o agente seguir de onde parou.";

export interface BackupSwitchDeps {
  restartCard: (cardId: string) => Promise<unknown>;
  startDriver: (cardId: string) => Promise<DriverSession>;
}

const realDeps: BackupSwitchDeps = {
  restartCard: (cardId) => restartCard(cardId, "account-backup"),
  startDriver: startCardDriver,
};

type Refusal = Extract<AccountTurnOutcome, { kind: "refused" }>;

const SAO_PAULO = "America/Sao_Paulo";

function formatRenewal(renewsAt: number, now: number): string {
  const time = new Date(renewsAt).toLocaleTimeString("pt-BR", { timeZone: SAO_PAULO, hour: "2-digit", minute: "2-digit" });
  const day = (at: number) => new Date(at).toLocaleDateString("pt-BR", { timeZone: SAO_PAULO });
  if (day(renewsAt) === day(now)) return time;
  const date = new Date(renewsAt).toLocaleDateString("pt-BR", { timeZone: SAO_PAULO, day: "2-digit", month: "2-digit" });
  return `${date} às ${time}`;
}

function refusalReason(from: string, refusal: Refusal): string {
  if (refusal.reason === "login") return `A conta ${from} não conseguiu entrar no Claude.`;
  if (refusal.renewsAt === undefined) return `A conta ${from} ficou sem limite de uso.`;
  return `A conta ${from} ficou sem limite até ${formatRenewal(refusal.renewsAt, Date.now())}.`;
}

function switchNote(backupSwitch: Extract<registry.BackupSwitch, { outcome: "switched" }>, refusal: Refusal): string {
  const destination = backupSwitch.returnedToOriginal
    ? `A conta ${backupSwitch.to} já renovou e o card voltou para ela.`
    : `Seguindo na conta ${backupSwitch.to}.`;
  return `${refusalReason(backupSwitch.from, refusal)} ${destination}`;
}

function exhaustedNote(backupSwitch: Extract<registry.BackupSwitch, { outcome: "exhausted" }>): string {
  const chain = `${BACKUP_CHAIN_EXHAUSTED_NOTE} (${backupSwitch.exhausted.join(", ")}). O card espera o limite renovar.`;
  return backupSwitch.unusableDefault ? `${chain} ${UNUSABLE_DEFAULT_ACCOUNT_NOTE}` : chain;
}

async function continueOnNewAccount(cardId: string, deps: BackupSwitchDeps): Promise<void> {
  await deps.restartCard(cardId);
  const session = await deps.startDriver(cardId);
  if (driverTurnRunning(cardId)) return;
  injectSystemTurn(session, BACKUP_SWITCH_CONTINUE_TEXT, SYSTEM_ORIGIN, 0);
}

export async function switchRefusedCardAccount(
  cardId: string,
  refusal: Refusal,
  deps: BackupSwitchDeps = realDeps,
): Promise<registry.BackupSwitch["outcome"]> {
  const backupSwitch = await registry.switchCardToBackupAccount(cardId, {
    reason: refusal.reason,
    ...(refusal.renewsAt !== undefined ? { renewsAt: refusal.renewsAt } : {}),
  });
  if (backupSwitch.outcome === "skipped") return backupSwitch.outcome;
  if (backupSwitch.outcome === "exhausted") {
    await emitCardSystemNote(cardId, exhaustedNote(backupSwitch));
    logger.warn(
      {
        audit: true, action: "card.account.backup.exhausted", card: backupSwitch.card.worktreeSlug,
        exhausted: backupSwitch.exhausted, unusableDefault: backupSwitch.unusableDefault,
      },
      "every account of the backup chain is out of plan usage — the card waits for a renewal",
    );
    return backupSwitch.outcome;
  }
  logger.info(
    {
      audit: true, action: "card.account.backup", card: backupSwitch.card.worktreeSlug, from: backupSwitch.from,
      to: backupSwitch.to, reason: refusal.reason, returnedToOriginal: backupSwitch.returnedToOriginal,
    },
    "card account refused the turn — switched to the next account of its backup chain",
  );
  await emitCardSystemNote(cardId, switchNote(backupSwitch, refusal));
  try {
    await continueOnNewAccount(cardId, deps);
  } catch (err) {
    await emitCardSystemNote(cardId, BACKUP_SWITCH_FAILED_NOTE);
    logger.warn(
      { audit: true, action: "card.account.backup.failed", card: backupSwitch.card.worktreeSlug, to: backupSwitch.to, detail: (err as Error).message },
      "switched to the backup account but could not reopen the chat on it",
    );
  }
  return backupSwitch.outcome;
}

async function switchClaimedRefusal(
  cardId: string,
  refusal: Refusal,
  deps: BackupSwitchDeps,
): Promise<registry.BackupSwitch["outcome"]> {
  try {
    return await switchRefusedCardAccount(cardId, refusal, deps);
  } catch (err) {
    logger.warn({ audit: true, action: "card.account.backup.error", card: cardId, detail: (err as Error).message }, "account backup switch could not run");
    // eslint-disable-next-line no-restricted-syntax -- best effort: the audit line above already records the failure the note would report
    await emitCardSystemNote(cardId, BACKUP_SWITCH_FAILED_NOTE).catch(() => undefined);
    return "skipped";
  }
}

export function watchAccountRefusals(deps: BackupSwitchDeps = realDeps): () => void {
  const claimedDrivers = new WeakSet<DriverSession>();
  const switchingCards = new Set<string>();
  const stopProbe = onCardAccountSwitchProbe((cardId) => switchingCards.has(cardId));
  const stopListening = onAccountTurnOutcome((cardId, outcome, driver) => {
    if (outcome.kind === "answered") {
      // eslint-disable-next-line no-restricted-syntax -- best effort: a chain left uncleared is cleared by the next answered turn
      void registry.clearCardBackupChain(cardId).catch(() => undefined);
      return;
    }
    if (claimedDrivers.has(driver)) return;
    claimedDrivers.add(driver);
    switchingCards.add(cardId);
    void switchClaimedRefusal(cardId, outcome, deps).then((result) => {
      switchingCards.delete(cardId);
      if (result !== "switched") claimedDrivers.delete(driver);
    });
  });
  return () => {
    stopListening();
    stopProbe();
  };
}

import { post, put } from "@/lib/api";
import type { AccountBackupResponse, Card, SessionChange } from "@/api/types";

export const accountsApi = {
  setBackup: (accountSlug: string, backupAccountSlug: string | null) =>
    put<AccountBackupResponse>(`/accounts/${encodeURIComponent(accountSlug)}/backup`, { backupAccountSlug }),
  returnCardAccount: (cardId: string) =>
    post<{ card: Card; session?: SessionChange }>(`/cards/${encodeURIComponent(cardId)}/account-return`),
};

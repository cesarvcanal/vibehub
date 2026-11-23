import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SELECT_CLASS } from "@/components/ui/select";
import { useT } from "@/i18n";
import { apiErrorMessage } from "@/lib/apiError";
import { ACCOUNTS_KEY } from "@/features/board/api";
import { accountsApi } from "../api";

interface AccountBackupOption {
  slug: string;
  label: string;
}

interface AccountBackupSelectProps {
  accountSlug: string;
  accountLabel: string;
  value: string | null;
  options: readonly AccountBackupOption[];
}

export function AccountBackupSelect({ accountSlug, accountLabel, value, options }: AccountBackupSelectProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const backupMutation = useMutation({
    mutationFn: (backupAccountSlug: string | null) => accountsApi.setBackup(accountSlug, backupAccountSlug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    onError: (error) => toast.error(apiErrorMessage(error, t("accounts.backup.error"))),
  });
  const otherAccounts = options.filter((option) => option.slug !== accountSlug);
  return (
    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">{t("accounts.backup.label")}</span>
      <select
        aria-label={t("accounts.backup.aria", { label: accountLabel })}
        className={`${SELECT_CLASS} h-7 min-w-0 flex-1 px-2 text-xs`}
        value={value ?? ""}
        disabled={backupMutation.isPending}
        onChange={(event) => backupMutation.mutate(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{t("accounts.backup.none")}</option>
        {otherAccounts.map((option) => (
          <option key={option.slug} value={option.slug}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

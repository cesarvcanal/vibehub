import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Loader2, LogIn, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiErrorMessage } from "@/lib/apiError";
import {
  ACCOUNTS_KEY,
  ACCOUNT_TOKENS_KEY,
  ACCOUNT_USAGE_KEY,
  DEFAULT_ACCOUNT_SLUG,
  accountLabel,
  boardApi,
  defaultAccountLabelOr,
} from "@/features/board/api";
import { AccountUsageBars, useMinuteTick } from "@/features/board/components/AccountUsageBars";
import { XTerminal } from "@/features/board/components/XTerminal";
import { t as translate, useT } from "@/i18n";

/**
 * Where the runner's built-in profile actually lives. Shown verbatim under the default row for the
 * same reason every other row shows its slug: this list is about directories in a container, and
 * "built-in profile" is a phrase you cannot `ls`.
 */
export const DEFAULT_PROFILE_PATH = "/root/.claude";

interface TokenTarget {
  slug: string;
  name: string;
  hasToken: boolean;
}

/**
 * Claude accounts.
 *
 * Each account is an isolated profile directory inside the runner, so several logins coexist and a
 * card can be pinned to one. The built-in profile is not a record — it shows up as a fixed row that
 * can be renamed and given a token like any other.
 *
 * A long-lived token (`claude setup-token`) is the way out of doing the browser login once per
 * profile: it goes into the server's vault and is planted in every runner profile. The value never
 * comes back, so the UI only ever knows whether one is stored.
 */
export function AccountsManager({ trigger = "icon" }: { trigger?: "icon" | "row" } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [tokenTarget, setTokenTarget] = React.useState<TokenTarget | null>(null);
  const [token, setToken] = React.useState("");
  const [loginTarget, setLoginTarget] = React.useState<TokenTarget | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: boardApi.listAccounts,
    enabled: open,
  });
  const accounts = data?.accounts ?? [];

  const { data: tokens } = useQuery({
    queryKey: ACCOUNT_TOKENS_KEY,
    queryFn: boardApi.accountTokens,
    enabled: open,
  });

  /**
   * Plan usage per account — the reason this dialog is worth opening BEFORE picking an account.
   * Only while the dialog is on screen, and no more often than the server's own 60s cache: the
   * endpoint behind it rate-limits by caller, so polling it harder buys nothing but a back-off.
   */
  const { data: usage } = useQuery({
    queryKey: ACCOUNT_USAGE_KEY,
    queryFn: boardApi.accountsUsage,
    enabled: open,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
  const now = useMinuteTick();

  /** true = that profile has never logged in interactively, which is exactly what the button fixes. */
  const needsLogin = (slug: string) => usage?.bySlug?.[slug]?.error === "no_credentials";

  // The default profile's display name lives in settings; the input only syncs from the server
  // while it is not being typed in.
  const savedLabel = data?.defaultLabel ?? "";
  const [labelDraft, setLabelDraft] = React.useState<string | null>(null);
  const labelValue = labelDraft ?? savedLabel;

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  }, [queryClient]);

  const labelMutation = useMutation({
    mutationFn: (value: string) => boardApi.setDefaultAccountLabel(value),
    onSuccess: () => {
      setLabelDraft(null);
      invalidate();
      toast.success(translate("toast.defaultAccountRenamed"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.defaultAccountRenameError"))),
  });

  const createMutation = useMutation({
    mutationFn: (value: string) => boardApi.createAccount(value),
    onSuccess: (account) => {
      invalidate();
      setName("");
      toast.success(translate("toast.accountCreated", { name: accountLabel(account), slug: account.slug }));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.accountCreateError"))),
  });

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => boardApi.deleteAccount(slug),
    onSuccess: () => {
      invalidate();
      toast.success(translate("toast.accountDeleted"));
    },
    // The server refuses while a card or project still points at it, and says how many.
    onError: (error) =>
      toast.error(apiErrorMessage(error, translate("toast.accountInUse"))),
  });

  const tokenMutation = useMutation({
    mutationFn: ({ slug, value }: { slug: string; value: string }) => boardApi.setAccountToken(slug, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_TOKENS_KEY });
      setToken("");
      setTokenTarget(null);
      toast.success(translate("toast.tokenStored"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.tokenStoreError"))),
  });

  const tokenDeleteMutation = useMutation({
    mutationFn: (slug: string) => boardApi.deleteAccountToken(slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_TOKENS_KEY });
      setTokenTarget(null);
      toast.success(translate("toast.tokenRemoved"));
    },
    onError: (error) => toast.error(apiErrorMessage(error, translate("toast.tokenRemoveError"))),
  });

  function saveLabel() {
    if (labelDraft === null || labelDraft.trim() === savedLabel) {
      setLabelDraft(null);
      return;
    }
    labelMutation.mutate(labelDraft.trim());
  }

  function submitAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate(name.trim());
  }

  function submitToken(event: React.FormEvent) {
    event.preventDefault();
    if (!tokenTarget || !token.trim() || tokenMutation.isPending) return;
    tokenMutation.mutate({ slug: tokenTarget.slug, value: token.trim() });
  }

  /**
   * Closing the login terminal is the moment to re-read everything the login may have changed: a
   * successful `/login` writes the credentials the usage meter reads, so the bars light up right
   * there instead of after the next poll — or, worse, after a reload nobody thinks to do.
   */
  function closeLogin() {
    setLoginTarget(null);
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_TOKENS_KEY });
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_USAGE_KEY });
  }

  /**
   * SIGN IN — the whole point of this row.
   *
   * It is primary exactly when the account has no credentials, because then it is not one option
   * among several, it IS the fix: an account in that state cannot run a card and has no usage to
   * show. Everywhere else it stays quiet, next to the token key.
   */
  const loginButton = (target: TokenTarget, needsLogin: boolean) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={needsLogin ? "default" : "ghost"}
          size={needsLogin ? "sm" : "icon"}
          className={needsLogin ? "h-7 shrink-0 px-2 text-xs" : "h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"}
          aria-label={t("accounts.signInFor", { name: target.name })}
          onClick={() => setLoginTarget(target)}
        >
          <LogIn className="h-4 w-4" />
          {needsLogin ? t("accounts.signIn") : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("accounts.signInHint")}</TooltipContent>
    </Tooltip>
  );

  const tokenButton = (target: TokenTarget) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={
            target.hasToken
              ? "h-7 w-7 shrink-0 text-emerald-400 hover:text-emerald-300"
              : "h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          }
          aria-label={t("accounts.tokenFor", { name: target.name })}
          onClick={() => {
            setToken("");
            setTokenTarget(target);
          }}
        >
          <KeyRound className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {target.hasToken ? t("accounts.tokenStored") : t("accounts.pasteToken")}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <>
      {/* Two homes: a quiet icon (legacy corners) or a labelled ROW inside Settings, where the
          managers live now — a setting you open twice a month belongs with the other settings. */}
      {trigger === "row" ? (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => setOpen(true)}
        >
          <Users className="h-4 w-4 text-muted-foreground" />
          {t("accounts.aria")}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={t("accounts.aria")}
          title={t("accounts.aria")}
          onClick={() => setOpen(true)}
        >
          <Users className="h-4 w-4" />
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounts.title")}</DialogTitle>
            <DialogDescription>
              {t("accounts.description1")}
              <span className="font-mono"> /login</span> {t("accounts.description2")}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="divide-y divide-border/60 rounded-md border border-border/60">
              <div className="flex items-center gap-2.5 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Input
                    aria-label={t("accounts.defaultName")}
                    className="h-7 text-sm"
                    placeholder={DEFAULT_ACCOUNT_SLUG}
                    value={labelValue}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onBlur={saveLabel}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") setLabelDraft(null);
                    }}
                  />
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {DEFAULT_PROFILE_PATH}
                    {tokens?.defaultHasToken ? t("accounts.tokenStoredSuffix") : ""}
                  </div>
                  <AccountUsageBars
                    slug={DEFAULT_ACCOUNT_SLUG}
                    usage={usage?.bySlug?.[DEFAULT_ACCOUNT_SLUG]}
                    now={now}
                  />
                </div>
                {loginButton(
                  {
                    slug: DEFAULT_ACCOUNT_SLUG,
                    name: defaultAccountLabelOr(savedLabel),
                    hasToken: Boolean(tokens?.defaultHasToken),
                  },
                  needsLogin(DEFAULT_ACCOUNT_SLUG),
                )}
                {tokenButton({
                  slug: DEFAULT_ACCOUNT_SLUG,
                  name: defaultAccountLabelOr(savedLabel),
                  hasToken: Boolean(tokens?.defaultHasToken),
                })}
              </div>

              {accounts.map((account) => {
                const label = accountLabel(account);
                const hasToken = Boolean(tokens?.bySlug?.[account.slug] ?? account.hasToken);
                return (
                  <div key={account.slug} className="flex items-center gap-2.5 px-3 py-2">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div title={label} className="truncate text-sm font-medium">
                        {label}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {account.slug}
                        {hasToken ? t("accounts.tokenStoredSuffix") : ""}
                      </div>
                      <AccountUsageBars slug={account.slug} usage={usage?.bySlug?.[account.slug]} now={now} />
                    </div>
                    {loginButton({ slug: account.slug, name: label, hasToken }, needsLogin(account.slug))}
                    {tokenButton({ slug: account.slug, name: label, hasToken })}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t("accounts.deleteAccount", { label })}
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate(account.slug)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}

              {accounts.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {t("accounts.none")}
                </p>
              ) : null}
            </div>
          )}

          <form onSubmit={submitAccount} className="flex items-center gap-2">
            <Input
              aria-label={t("accounts.nameAria")}
              placeholder={t("accounts.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              {t("common.add")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* LOGIN, on screen. This used to mean SSHing to the runner and running `claude /login` by
          hand in the right profile — the one step of onboarding that was not in the product. The
          pty on the other end is already inside this account's profile directory, so whatever it
          writes belongs to this account and nothing else. */}
      <Dialog open={Boolean(loginTarget)} onOpenChange={(next) => !next && closeLogin()}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("accounts.signInFor", { name: loginTarget?.name })}</DialogTitle>
            <DialogDescription>{t("accounts.loginHelp")}</DialogDescription>
          </DialogHeader>
          {loginTarget ? (
            <div className="h-[26rem] overflow-hidden rounded-md border border-border/60">
              <XTerminal
                wsPath={`/api/accounts/${encodeURIComponent(loginTarget.slug)}/login-terminal`}
                zoomControl
                ariaLabel={t("accounts.loginTerminalAria", { name: loginTarget.name })}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(tokenTarget)} onOpenChange={(next) => !next && setTokenTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounts.tokenFor", { name: tokenTarget?.name })}</DialogTitle>
            <DialogDescription>
              {t("accounts.tokenDialogBody1")} <code className="font-mono">claude setup-token</code>
              {t("accounts.tokenDialogBody2")}
            </DialogDescription>
          </DialogHeader>

          {tokenTarget?.hasToken ? (
            <p className="text-xs text-emerald-400">{t("accounts.tokenAlready")}</p>
          ) : null}

          <form onSubmit={submitToken} className="flex flex-col gap-3">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("accounts.tokenAria")}
              placeholder="sk-ant-oat01-…"
              className="font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="flex items-center justify-between gap-2">
              {tokenTarget?.hasToken ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={tokenDeleteMutation.isPending}
                  onClick={() => tokenTarget && tokenDeleteMutation.mutate(tokenTarget.slug)}
                >
                  {t("accounts.removeToken")}
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" size="sm" disabled={tokenMutation.isPending || !token.trim()}>
                {tokenMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                {t("accounts.saveToken")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

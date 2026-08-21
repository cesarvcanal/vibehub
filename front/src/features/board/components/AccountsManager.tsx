import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, Trash2, Users } from "lucide-react";
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
  DEFAULT_ACCOUNT_SLUG,
  accountLabel,
  boardApi,
} from "@/features/board/api";

/** Fallback name for the runner's built-in profile when nobody has renamed it. */
export const DEFAULT_ACCOUNT_FALLBACK = "Default account";

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
export function AccountsManager() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [tokenTarget, setTokenTarget] = React.useState<TokenTarget | null>(null);
  const [token, setToken] = React.useState("");

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
      toast.success("Default account renamed.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not rename the default account")),
  });

  const createMutation = useMutation({
    mutationFn: (value: string) => boardApi.createAccount(value),
    onSuccess: (account) => {
      invalidate();
      setName("");
      toast.success(`Account “${accountLabel(account)}” created (${account.slug}).`);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not create the account")),
  });

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => boardApi.deleteAccount(slug),
    onSuccess: () => {
      invalidate();
      toast.success("Account deleted.");
    },
    // The server refuses while a card or project still points at it, and says how many.
    onError: (error) =>
      toast.error(apiErrorMessage(error, "That account is still in use — move its cards first")),
  });

  const tokenMutation = useMutation({
    mutationFn: ({ slug, value }: { slug: string; value: string }) => boardApi.setAccountToken(slug, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_TOKENS_KEY });
      setToken("");
      setTokenTarget(null);
      toast.success("Token stored in the vault and planted in the runner profiles.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not store the token")),
  });

  const tokenDeleteMutation = useMutation({
    mutationFn: (slug: string) => boardApi.deleteAccountToken(slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACCOUNT_TOKENS_KEY });
      setTokenTarget(null);
      toast.success("Token removed.");
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not remove the token")),
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
          aria-label={`Long-lived token — ${target.name}`}
          onClick={() => {
            setToken("");
            setTokenTarget(target);
          }}
        >
          <KeyRound className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{target.hasToken ? "Token stored" : "Paste a long-lived token"}</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      <Button variant="outline" size="sm" className="h-8" onClick={() => setOpen(true)}>
        <Users /> Accounts
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Claude accounts</DialogTitle>
            <DialogDescription>
              Each account is a separate Claude login inside the runner. Open a card on it and run
              <span className="font-mono"> /login</span> once — or paste a long-lived token and skip
              the browser dance everywhere.
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
                    aria-label="Default account name"
                    className="h-7 text-sm"
                    placeholder={DEFAULT_ACCOUNT_FALLBACK}
                    value={labelValue}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onBlur={saveLabel}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") setLabelDraft(null);
                    }}
                  />
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    built-in profile{tokens?.defaultHasToken ? " · token stored" : ""}
                  </div>
                </div>
                {tokenButton({
                  slug: DEFAULT_ACCOUNT_SLUG,
                  name: savedLabel || DEFAULT_ACCOUNT_FALLBACK,
                  hasToken: Boolean(tokens?.defaultHasToken),
                })}
              </div>

              {accounts.map((account) => {
                const label = accountLabel(account);
                const hasToken = Boolean(tokens?.bySlug?.[account.slug] ?? account.hasToken);
                return (
                  <div key={account.slug} className="flex items-center gap-2.5 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div title={label} className="truncate text-sm font-medium">
                        {label}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {account.slug}
                        {hasToken ? " · token stored" : ""}
                      </div>
                    </div>
                    {tokenButton({ slug: account.slug, name: label, hasToken })}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete account ${label}`}
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
                  No extra accounts — every card uses the runner's built-in profile.
                </p>
              ) : null}
            </div>
          )}

          <form onSubmit={submitAccount} className="flex items-center gap-2">
            <Input
              aria-label="Account name"
              placeholder="Account name (e.g. Personal)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              Add
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(tokenTarget)} onOpenChange={(next) => !next && setTokenTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Long-lived token — {tokenTarget?.name}</DialogTitle>
            <DialogDescription>
              In any card's terminal run <code className="font-mono">claude setup-token</code>, then
              paste it here. It is stored in this server's vault and never sent back to the browser.
            </DialogDescription>
          </DialogHeader>

          {tokenTarget?.hasToken ? (
            <p className="text-xs text-emerald-400">A token is stored. Pasting a new one replaces it.</p>
          ) : null}

          <form onSubmit={submitToken} className="flex flex-col gap-3">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Long-lived token"
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
                  Remove token
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" size="sm" disabled={tokenMutation.isPending || !token.trim()}>
                {tokenMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                Save token
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

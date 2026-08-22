import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { patch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/apiError";
import { SELECT_CLASS } from "@/features/board/components/NewCardDialog";
import {
  ACCOUNTS_KEY,
  GITHUB_KEY,
  PROJECTS_KEY,
  accountLabel,
  boardApi,
  githubBranchesKey,
  githubReposKey,
  splitRepo,
  type BoardProject,
} from "@/features/board/api";
import type { GithubConnection } from "@/api/types";
import { t as translate, useT } from "@/i18n";

/**
 * New project — or, with `project` given, editing an existing one.
 *
 * A project is a repository plus the branch its cards are cut from. The repository picker searches
 * server-side (`GET /api/github/repos?connection=&q=`) because an account with hundreds of
 * repositories makes a plain dropdown useless, and picking one fills in the name and the base
 * branch — the two things you would otherwise have to type correctly by hand.
 *
 * WHICH GITHUB ACCOUNT. vibehub can hold several (a personal one and an organization's is the usual
 * pair), and a repository only exists inside one of them — so when there is more than one, the
 * account comes FIRST and the repository search reads through it. With a single account there is
 * nothing to decide, so the field is not shown at all.
 *
 * A project with no repository is valid: its cards open in a scratch directory.
 *
 * CONNECTING AN ACCOUNT HAPPENS HERE. With nothing connected there is no repository picker, and a
 * line of prose pointing at Settings is a dead end at the exact moment somebody is trying to create
 * their first project — they came to pick a repository, so this is where the token goes in. The
 * same form is one click away ("+ account") once there IS a connection, because a second account is
 * added for the same reason: the repo you want is not in the list.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  onCreated,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: BoardProject) => void;
  /** Editing an existing project instead of creating one. */
  project?: BoardProject;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [connection, setConnection] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  // Only meaningful when something IS connected: with nothing connected the form is the empty
  // state itself and is always on screen.
  const [connecting, setConnecting] = React.useState(false);

  // The search box hits the server, so give the typist a beat before asking GitHub.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: github } = useQuery({ queryKey: GITHUB_KEY, queryFn: boardApi.github, enabled: open });
  const connections = React.useMemo(() => github?.connections ?? [], [github]);
  const connected = connections.length > 0;

  // Empty = the server's own default, which is the first connection. Keeping it empty rather than
  // pre-selecting an id means a single-account install stores no reference at all.
  const activeConnection = connection || connections[0]?.id || "";

  const { data: repos, isFetching: reposLoading } = useQuery({
    queryKey: githubReposKey(activeConnection, debounced),
    queryFn: () => boardApi.githubRepos(activeConnection, debounced),
    enabled: open && connected,
  });

  const { data: accountsData } = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: boardApi.listAccounts,
    enabled: open,
  });
  const accounts = accountsData?.accounts ?? [];

  const selected = repos?.find((r) => r.fullName === repo);
  const { owner, repo: repoName } = splitRepo(repo);

  const { data: branches } = useQuery({
    queryKey: githubBranchesKey(activeConnection, owner ?? "", repoName ?? ""),
    queryFn: () => boardApi.githubBranches(activeConnection, owner as string, repoName as string),
    enabled: open && Boolean(owner && repoName),
  });

  // Pick a sensible base branch ONCE per repository, then leave the operator's choice alone.
  const applied = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selected || !branches) return;
    if (applied.current === selected.fullName) return;
    applied.current = selected.fullName;
    const preferred = ["dev", "develop", "main", "master"].find((b) => branches.includes(b));
    setBranch(preferred ?? selected.defaultBranch ?? branches[0] ?? "main");
  }, [branches, selected]);

  // Reset means "back to what this dialog opened with": empty for a new project, the stored values
  // when editing one.
  const reset = React.useCallback(() => {
    setName(project?.name ?? "");
    setRepo(project?.repoFullName ?? "");
    setCloneUrl(project?.cloneUrl ?? "");
    setBranch(project?.baseBranch ?? "");
    setAccount(project?.defaultAccountSlug ?? "");
    setConnection(project?.githubConnectionId ?? "");
    setSearch("");
    setDebounced("");
    setConnecting(false);
    applied.current = project?.repoFullName ?? null;
  }, [project]);

  // Hydrate from the project every time the dialog opens on one — editing a second project must not
  // show the first one's fields.
  React.useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const createMutation = useMutation({
    mutationFn: async (): Promise<BoardProject> => {
      const body = {
        name: name.trim(),
        repoFullName: repo || null,
        cloneUrl: (selected?.cloneUrl ?? cloneUrl.trim()) || null,
        baseBranch: branch.trim() || undefined,
        defaultAccountSlug: account || null,
        // null CLEARS it: a project on the only account should not pin an id it does not need.
        githubConnectionId: connection || null,
      };
      if (project) {
        const r = await patch<{ project: BoardProject }>(`/projects/${encodeURIComponent(project.id)}`, body);
        return r.project;
      }
      return await boardApi.createProject({
        name: body.name,
        repo: repo || undefined,
        cloneUrl: body.cloneUrl ?? undefined,
        defaultBranch: body.baseBranch,
        accountSlug: account || undefined,
        githubConnectionId: connection || undefined,
      });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      toast.success(
        project
          ? translate("toast.projectSaved", { name: saved.name })
          : translate("toast.projectCreated", { name: saved.name }),
      );
      reset();
      onOpenChange(false);
      onCreated?.(saved);
    },
    onError: (error) =>
      toast.error(
        apiErrorMessage(
          error,
          project ? translate("toast.projectSaveError") : translate("toast.projectCreateError"),
        ),
      ),
  });

  /** A freshly connected account becomes the one this project reads through. */
  function applyConnection(added: GithubConnection) {
    setConnection(added.id);
    setRepo("");
    setBranch("");
    applied.current = null;
    setConnecting(false);
  }

  function pickRepo(fullName: string) {
    setRepo(fullName);
    applied.current = null;
    if (!fullName) {
      setBranch("");
      return;
    }
    // Only fill the name in if it is still untouched — never overwrite what somebody typed.
    if (!name.trim()) setName(fullName.split("/")[1] ?? fullName);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{project ? t("project.settingsTitle") : t("project.newTitle")}</DialogTitle>
          <DialogDescription>
            {t("project.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {/* Name first, and focused. It is the only required field, it is the one thing only a
              person can decide, and picking a repository below FILLS IT IN — so the form reads as
              "here is what I am calling it, here is where the code is", not as a quiz. */}
          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t("project.name")}</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("project.namePlaceholder")}
            />
          </div>

          {/* Which GitHub identity this repository lives under. Only worth asking when there is more
              than one — otherwise the answer is forced and the field is noise. */}
          {connections.length > 1 ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="project-connection">{t("project.account")}</Label>
                <AddAccountLink open={connecting} onToggle={() => setConnecting((v) => !v)} />
              </div>
              <select
                id="project-connection"
                aria-label={t("project.githubAccount")}
                className={SELECT_CLASS}
                value={activeConnection}
                onChange={(e) => {
                  setConnection(e.target.value);
                  // A repository belongs to ONE account — keeping the old pick would clone the
                  // wrong thing, or nothing at all.
                  setRepo("");
                  setBranch("");
                  applied.current = null;
                }}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {c.login}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                {t("project.connectionHint")}
              </p>
            </div>
          ) : null}

          {/* Adding an account when there already is one: the link lives next to the account select
              when there is one to sit beside, and next to the repository label otherwise. */}
          {connected && connecting ? (
            <GithubConnectBox onConnected={applyConnection} onCancel={() => setConnecting(false)} />
          ) : null}

          {connected ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="project-repo-search">{t("project.repository")}</Label>
                {connections.length > 1 ? null : (
                  <AddAccountLink open={connecting} onToggle={() => setConnecting((v) => !v)} />
                )}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="project-repo-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("project.searchRepos")}
                  className="pl-8"
                  autoComplete="off"
                />
              </div>
              <select
                aria-label={t("project.repository")}
                className={SELECT_CLASS}
                value={repo}
                onChange={(e) => pickRepo(e.target.value)}
                size={1}
              >
                <option value="">
                  {reposLoading ? t("project.loadingRepos") : t("project.noRepo")}
                </option>
                {(repos ?? []).map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                    {r.private ? t("project.private") : ""}
                  </option>
                ))}
              </select>
              {!reposLoading && debounced && (repos?.length ?? 0) === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("project.nothingMatched", { q: debounced })}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              {/* THE empty state. Not a sentence pointing somewhere else: the thing that is missing,
                  and the form that supplies it, in the place where it was missed. */}
              <GithubConnectBox onConnected={applyConnection} />
              <div className="space-y-1.5">
                <Label htmlFor="project-clone-url">{t("project.cloneUrl")}</Label>
                <Input
                  id="project-clone-url"
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="font-mono"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("project.noGithubHint")}
                </p>
              </div>
            </div>
          )}

          {repo || cloneUrl.trim() ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-branch">{t("project.baseBranch")}</Label>
              {branches?.length ? (
                <select
                  id="project-branch"
                  className={SELECT_CLASS}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="project-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="dev"
                  className="font-mono"
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                {t("project.branchHint")}
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="project-account">{t("project.defaultAccount")}</Label>
            <select
              id="project-account"
              className={SELECT_CLASS}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t("project.runnerDefault")}</option>
              {accounts.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone="info">{selected.fullName}</Badge>
              <span className="font-mono">{selected.cloneUrl}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              // Resets on the way out, like the Dialog's own close — otherwise an abandoned repo
              // choice is still selected the next time this opens.
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={createMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {project ? t("project.save") : t("project.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


/** The "+ account" affordance. A link, not a button: it opens a form, it does not save anything. */
function AddAccountLink({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-[11px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
    >
      {open ? t("common.cancel") : t("github.addAccount")}
    </button>
  );
}

/**
 * Connecting a GitHub account without leaving the dialog: a name, a token, one button.
 *
 * It is NOT a `<form>` — it is rendered inside the project form, and a nested form is invalid HTML
 * that browsers resolve by ignoring the inner one. So the button is a plain button and Enter in
 * either field submits this box explicitly, which also stops Enter from creating a half-filled
 * project while somebody is pasting a token.
 *
 * The error is shown INLINE rather than as a toast: a bad token is a correction to make in the
 * field right above it, and a toast that vanishes takes the reason with it.
 */
function GithubConnectBox({
  onConnected,
  onCancel,
}: {
  onConnected: (connection: GithubConnection) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [label, setLabel] = React.useState("");
  const [token, setToken] = React.useState("");

  const connect = useMutation({
    mutationFn: () => boardApi.addGithubConnection(label.trim(), token.trim()),
    onSuccess: (connection) => {
      // The whole `["board", "github", …]` subtree: the connection list AND every repo/branch query
      // read through it, so the picker below appears already filled.
      void queryClient.invalidateQueries({ queryKey: GITHUB_KEY });
      setLabel("");
      setToken("");
      toast.success(
        translate("toast.githubAdded", {
          label: connection.label || connection.login,
          login: connection.login,
        }),
      );
      onConnected(connection);
    },
  });

  const canSubmit = Boolean(token.trim()) && !connect.isPending;
  function submit() {
    if (canSubmit) connect.mutate();
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3" data-testid="github-connect">
      <p className="text-xs font-semibold">{t("github.connectTitle")}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <strong className="font-medium text-foreground">{t("github.pasteToken")}</strong>
        {t("github.pasteTokenRest")}
        <span className="font-mono">repo</span>.{" "}
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 hover:text-foreground"
        >
          github.com/settings/tokens
        </a>
      </p>
      <Input
        aria-label={t("github.accountName")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("github.accountNamePlaceholder")}
        autoComplete="off"
        maxLength={40}
      />
      <Input
        aria-label={t("github.accessToken")}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("github.tokenPlaceholder")}
        autoComplete="off"
        className={cn("font-mono", connect.isError && "border-destructive")}
      />
      {connect.isError ? (
        <p role="alert" className="text-[11px] leading-relaxed text-destructive">
          {apiErrorMessage(connect.error, translate("github.connectFailed"))}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={connect.isPending}>
            {t("common.cancel")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={!canSubmit} onClick={submit}>
          {connect.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {t("github.connect")}
        </Button>
      </div>
    </div>
  );
}

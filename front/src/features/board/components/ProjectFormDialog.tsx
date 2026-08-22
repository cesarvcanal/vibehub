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
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [connection, setConnection] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");

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
      toast.success(project ? `Project “${saved.name}” saved.` : `Project “${saved.name}” created.`);
      reset();
      onOpenChange(false);
      onCreated?.(saved);
    },
    onError: (error) =>
      toast.error(apiErrorMessage(error, project ? "Could not save the project" : "Could not create the project")),
  });

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
          <DialogTitle>{project ? "Project settings" : "New project"}</DialogTitle>
          <DialogDescription>
            A project groups cards. Each card gets its own worktree and its own Claude terminal
            inside the runner.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {/* Name first, and focused. It is the only required field, it is the one thing only a
              person can decide, and picking a repository below FILLS IT IN — so the form reads as
              "here is what I am calling it, here is where the code is", not as a quiz. */}
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. billing-service"
            />
          </div>

          {/* Which GitHub identity this repository lives under. Only worth asking when there is more
              than one — otherwise the answer is forced and the field is noise. */}
          {connections.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-connection">Account</Label>
              <select
                id="project-connection"
                aria-label="GitHub account"
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
                Which GitHub account this project's repository belongs to.
              </p>
            </div>
          ) : null}

          {connected ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-repo-search">Repository</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="project-repo-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search your repositories…"
                  className="pl-8"
                  autoComplete="off"
                />
              </div>
              <select
                aria-label="Repository"
                className={SELECT_CLASS}
                value={repo}
                onChange={(e) => pickRepo(e.target.value)}
                size={1}
              >
                <option value="">
                  {reposLoading ? "Loading repositories…" : "No repository (scratch directory)"}
                </option>
                {(repos ?? []).map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                    {r.private ? " · private" : ""}
                  </option>
                ))}
              </select>
              {!reposLoading && debounced && (repos?.length ?? 0) === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nothing matched “{debounced}”.</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="project-clone-url">Clone URL</Label>
              <Input
                id="project-clone-url"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="font-mono"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                No GitHub account is connected, so there is nothing to pick from. Add one in Settings
                — it is a pasted token, not a login — or paste a clone URL here, or leave it empty
                and the cards open in a scratch directory.
              </p>
            </div>
          )}

          {repo || cloneUrl.trim() ? (
            <div className="space-y-1.5">
              <Label htmlFor="project-branch">Base branch</Label>
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
                Every card's worktree is cut from this branch.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="project-account">Default Claude account</Label>
            <select
              id="project-account"
              className={SELECT_CLASS}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">Runner default</option>
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
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !name.trim()}>
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              {project ? "Save project" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

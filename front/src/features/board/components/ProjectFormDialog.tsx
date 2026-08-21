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
 * New project.
 *
 * A project is a repository plus the branch its cards are cut from. The repository picker searches
 * server-side (`GET /api/github/repos?q=`) because an account with hundreds of repositories makes a
 * plain dropdown useless, and picking one fills in the name and the base branch — the two things
 * you would otherwise have to type correctly by hand.
 *
 * A project with no repository is valid: its cards open in a scratch directory.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: BoardProject) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");

  // The search box hits the server, so give the typist a beat before asking GitHub.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: github } = useQuery({ queryKey: GITHUB_KEY, queryFn: boardApi.github, enabled: open });
  const connected = Boolean(github?.connected);

  const { data: repos, isFetching: reposLoading } = useQuery({
    queryKey: githubReposKey(debounced),
    queryFn: () => boardApi.githubRepos(debounced),
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
    queryKey: githubBranchesKey(owner ?? "", repoName ?? ""),
    queryFn: () => boardApi.githubBranches(owner as string, repoName as string),
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

  const reset = React.useCallback(() => {
    setName("");
    setRepo("");
    setCloneUrl("");
    setBranch("");
    setAccount("");
    setSearch("");
    setDebounced("");
    applied.current = null;
  }, []);

  const createMutation = useMutation({
    mutationFn: () =>
      boardApi.createProject({
        name: name.trim(),
        repo: repo || undefined,
        cloneUrl: (selected?.cloneUrl ?? cloneUrl.trim()) || undefined,
        defaultBranch: branch.trim() || undefined,
        accountSlug: account || undefined,
      }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      toast.success(`Project “${project.name}” created.`);
      reset();
      onOpenChange(false);
      onCreated?.(project);
    },
    onError: (error) => toast.error(apiErrorMessage(error, "Could not create the project")),
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
          <DialogTitle>New project</DialogTitle>
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
                GitHub is not connected, so there is nothing to pick from. Paste a clone URL, or
                leave it empty and the cards open in a scratch directory.
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
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, patch, post, del } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import type { Settings, SettingsPatch, GithubConnection, GithubState, TranscribeStatus } from "@/api/types";

/**
 * The install's own settings — the handful of things the wizard asked once and you may want to
 * change later: who the runner commits as, whether the agent asks before every tool call, what the
 * default account is called, the GitHub connection, and the keys behind voice input.
 *
 * Secrets go in, never come back: the dialog shows "stored" / "not stored" and a field that
 * replaces the value when filled.
 */

export const SETTINGS_KEY = ["settings"] as const;
export const GITHUB_KEY = ["github"] as const;
export const TRANSCRIBE_KEY = ["transcribe"] as const;

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<Settings>("/settings"), enabled: open });
  const github = useQuery({ queryKey: GITHUB_KEY, queryFn: () => get<GithubState>("/github"), enabled: open });
  const voice = useQuery({ queryKey: TRANSCRIBE_KEY, queryFn: () => get<TranscribeStatus>("/transcribe"), enabled: open });

  const connections = github.data?.connections ?? [];

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [autonomous, setAutonomous] = React.useState(true);
  const [defaultLabel, setDefaultLabel] = React.useState("");
  const [language, setLanguage] = React.useState("");
  const [githubLabel, setGithubLabel] = React.useState("");
  const [githubToken, setGithubToken] = React.useState("");
  const [openaiKey, setOpenaiKey] = React.useState("");
  const [anthropicKey, setAnthropicKey] = React.useState("");

  // Hydrate the form from the server once per open; later edits are the person's.
  React.useEffect(() => {
    if (!open || !settings.data) return;
    setName(settings.data.git.name);
    setEmail(settings.data.git.email);
    setAutonomous(settings.data.autonomous);
    setDefaultLabel(settings.data.defaultAccountLabel ?? "");
    setLanguage(settings.data.transcribeLanguage ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.data]);

  const save = useMutation({
    mutationFn: (body: SettingsPatch) => patch<Settings>("/settings", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "accounts"] });
      toast.success("Settings saved.");
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const addGithub = useMutation({
    mutationFn: (body: { label: string; token: string }) =>
      post<{ connection: GithubConnection }>("/github/connections", body),
    onSuccess: (result) => {
      setGithubToken("");
      setGithubLabel("");
      void qc.invalidateQueries({ queryKey: GITHUB_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "github"] });
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      toast.success(`Added ${result.connection.label} (${result.connection.login}).`);
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  // The server REFUSES (409) while a project still points at the account — the message names how
  // many, which is exactly what the person needs to go and fix, so it is shown verbatim.
  const removeGithub = useMutation({
    mutationFn: (id: string) => del<{ ok: true }>(`/github/connections/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GITHUB_KEY });
      void qc.invalidateQueries({ queryKey: ["board", "github"] });
      toast.success("Account removed.");
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const saveVoice = useMutation({
    mutationFn: (body: { openaiKey?: string; anthropicKey?: string }) => post<TranscribeStatus>("/transcribe/keys", body),
    onSuccess: () => {
      setOpenaiKey("");
      setAnthropicKey("");
      void qc.invalidateQueries({ queryKey: TRANSCRIBE_KEY });
      toast.success("Voice keys updated.");
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const submitGeneral = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate({
      git: { name: name.trim(), email: email.trim() },
      autonomous,
      defaultAccountLabel: defaultLabel.trim() || null,
      transcribeLanguage: language.trim() || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            The install's choices. Secrets are stored in the vault and never shown again.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submitGeneral} className="space-y-4" data-testid="settings-general">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Git identity</h3>
            <p className="text-xs text-muted-foreground">What the runner commits as, in every card.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="settings-git-name">Name</Label>
                <Input id="settings-git-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-git-email">Email</Label>
                <Input id="settings-git-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent</h3>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="settings-autonomous">Run without permission prompts</Label>
                <p className="text-xs text-muted-foreground">
                  The runner is an isolated container — what it reaches is what you connected. Off = Claude asks, and the card waits.
                </p>
              </div>
              <Switch id="settings-autonomous" checked={autonomous} onCheckedChange={setAutonomous} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-default-label">Default account label</Label>
              <Input
                id="settings-default-label"
                value={defaultLabel}
                onChange={(e) => setDefaultLabel(e.target.value)}
                placeholder="default"
                maxLength={40}
              />
              <p className="text-xs text-muted-foreground">How the built-in profile (/root/.claude) is named in pickers.</p>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Voice input</h3>
            <div className="space-y-1.5">
              <Label htmlFor="settings-language">Transcription language</Label>
              <Input
                id="settings-language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="auto (or a two-letter code: pt, en, es…)"
                maxLength={2}
                className="font-mono"
              />
            </div>
          </section>

          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending || !name.trim() || !email.trim()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>

        <section className="space-y-3 border-t border-border/60 pt-4" data-testid="settings-github">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">GitHub accounts</h3>
          {/* The one thing people ask first: there is no "Sign in with GitHub" here. You paste a
              token. Saying it plainly, above the field, is cheaper than a support conversation. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">Paste a token — no login needed.</strong>{" "}
            Fine-grained PAT with Contents read/write on the repos you want, or a classic token with{" "}
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
          <p className="text-xs text-muted-foreground">
            Add one account per GitHub identity — your personal one and your organization's, say. Each
            project picks which one it clones with; the token only leaves the vault as an ephemeral
            clone credential.
          </p>

          {connections.length > 0 ? (
            <ul className="divide-y divide-border/60 rounded-md border border-border/60" data-testid="github-connections">
              {connections.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{c.login}</span>
                      {c.scopes?.length ? ` · ${c.scopes.join(", ")}` : " · fine-grained"}
                      {c.ok === false ? ` · ${c.error ?? "token not usable"}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove ${c.label}`}
                    disabled={removeGithub.isPending}
                    onClick={() => removeGithub.mutate(c.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No account connected yet. Projects cannot pick a repository until there is one.
            </p>
          )}

          <div className="space-y-2 rounded-md border border-dashed border-border/60 p-3">
            <p className="text-xs font-medium">Add account</p>
            <Input
              aria-label="Account label"
              value={githubLabel}
              onChange={(e) => setGithubLabel(e.target.value)}
              placeholder="personal, acme org…"
              autoComplete="off"
              maxLength={40}
            />
            <Input
              aria-label="GitHub token"
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="github_pat_… or ghp_…"
              autoComplete="off"
              className="font-mono"
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={!githubToken.trim() || addGithub.isPending}
                onClick={() => addGithub.mutate({ label: githubLabel.trim(), token: githubToken.trim() })}
              >
                {addGithub.isPending ? "Checking…" : "Add account"}
              </Button>
            </div>
          </div>
        </section>

        <section className="space-y-3 border-t border-border/60 pt-4" data-testid="settings-voice">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Voice keys</h3>
          <p className="text-xs text-muted-foreground">
            Whisper (OpenAI) transcribes the composer's recordings
            {voice.data?.available ? " — key stored" : " — no key, microphone unavailable"}.
            A Claude key adds a proofreading pass that uses the brain as its glossary
            {voice.data?.proofread ? " — key stored" : " — not stored"}.
          </p>
          <div className="grid grid-cols-1 gap-2">
            <Input
              aria-label="OpenAI API key"
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={voice.data?.available ? "OpenAI key (paste to replace)" : "OpenAI key (sk-…)"}
              autoComplete="off"
              className="font-mono"
            />
            <Input
              aria-label="Anthropic API key"
              type="password"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder={voice.data?.proofread ? "Anthropic key (paste to replace)" : "Anthropic key (sk-ant-…), optional"}
              autoComplete="off"
              className="font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            {voice.data?.available ? (
              <Button type="button" variant="ghost" disabled={saveVoice.isPending} onClick={() => saveVoice.mutate({ openaiKey: "", anthropicKey: "" })}>
                Remove keys
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={saveVoice.isPending || (!openaiKey.trim() && !anthropicKey.trim())}
              onClick={() => saveVoice.mutate({
                ...(openaiKey.trim() ? { openaiKey: openaiKey.trim() } : {}),
                ...(anthropicKey.trim() ? { anthropicKey: anthropicKey.trim() } : {}),
              })}
            >
              Save keys
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

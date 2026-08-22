import * as React from "react";
import { get, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import type { GithubConnection, GithubState } from "@/api/types";

/**
 * Step 3 — optional. Paste a token, we validate it against GitHub and show who it belongs to.
 *
 * There is NO OAuth flow anywhere in vibehub, and this is the first place anybody looks for one — so
 * the step says outright what it wants: a token, pasted. More accounts (a personal one, an
 * organization's) are added later in Settings; the wizard only needs the first.
 */
export function GithubStep({
  meta,
  onDone,
  onSkip,
}: {
  meta: SetupStepMeta;
  onDone: () => Promise<void>;
  onSkip: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [resolved, setResolved] = React.useState<GithubConnection | null>(null);

  const canSubmit = token.trim().length > 0 && !busy;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // The wizard's route: it creates the FIRST connection (and replaces it on a retry), so
      // pasting a second token here never leaves a half-connected account behind.
      await post("/github/token", { token: token.trim(), label: label.trim() });
      const state = await get<GithubState>("/github");
      const connection = state.connections?.[0] ?? null;
      setResolved(connection);
      setToken("");
      if (connection) {
        await onDone();
        return;
      }
      setError("GitHub did not accept that token.");
    } catch (err) {
      setError(apiErrorMessage(err, "Could not store the token"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepFrame
        title={meta.title}
        why={meta.why}
        footer={
          <>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "Checking…" : "Connect"}
            </Button>
            <Button type="button" variant="ghost" onClick={onSkip} disabled={busy}>
              Skip for now
            </Button>
          </>
        }
      >
        <div className="space-y-3 sm:max-w-lg">
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

          <div className="space-y-1.5">
            <Label htmlFor="github-label">Account name</Label>
            <Input
              id="github-label"
              autoComplete="off"
              spellCheck={false}
              placeholder="personal"
              maxLength={40}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              aria-describedby="github-label-hint"
            />
            <p id="github-label-hint" className="text-xs text-muted-foreground">
              What to call this account. You can add more later in Settings — one per GitHub identity.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="github-token">Access token</Label>
            <Input
              id="github-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_… or ghp_…"
              className="font-mono"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              aria-describedby="github-token-hint"
            />
            <p id="github-token-hint" className="text-xs leading-relaxed text-muted-foreground">
              Stored in this server's vault and never sent back to the browser — it only leaves as an
              ephemeral clone credential.
            </p>
          </div>
        </div>

        {resolved ? (
          <p className="flex items-center gap-2 text-sm">
            <Badge tone="ok">connected</Badge>
            <span className="text-muted-foreground">
              signed in as <span className="font-mono text-foreground">{resolved.login}</span>
              {resolved.scopes?.length ? ` · ${resolved.scopes.join(", ")}` : ""}
            </span>
          </p>
        ) : null}

        <StepError message={error} />
      </StepFrame>
    </form>
  );
}

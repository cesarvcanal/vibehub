import * as React from "react";
import { get, post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import type { GithubState } from "@/api/types";

/** Step 3 — optional. Paste a token, we validate it against GitHub and show who it belongs to. */
export function GithubStep({
  meta,
  onDone,
  onSkip,
}: {
  meta: SetupStepMeta;
  onDone: () => Promise<void>;
  onSkip: () => void;
}) {
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [resolved, setResolved] = React.useState<GithubState | null>(null);

  const canSubmit = token.trim().length > 0 && !busy;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await post("/github/token", { token: token.trim() });
      const state = await get<GithubState>("/github");
      setResolved(state);
      setToken("");
      if (state.connected) {
        await onDone();
        return;
      }
      setError(state.error ?? "GitHub did not accept that token.");
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
        <div className="space-y-1.5 sm:max-w-lg">
          <Label htmlFor="github-token">Personal access token</Label>
          <Input
            id="github-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ghp_…"
            className="font-mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            aria-describedby="github-token-hint"
          />
          <p id="github-token-hint" className="text-xs leading-relaxed text-muted-foreground">
            Needs <span className="font-mono">repo</span> scope to clone private repositories. The
            token is stored in this server's vault and never sent back to the browser.
          </p>
        </div>

        {resolved?.connected ? (
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

import * as React from "react";
import { post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StepError, StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import { useT } from "@/i18n";

const MIN_PASSWORD = 8;

/** Step 1 — creates the first account. `POST /api/setup/owner` also signs you in. */
export function OwnerStep({ meta, onDone }: { meta: SetupStepMeta; onDone: () => Promise<void> }) {
  const t = useT();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    username.trim().length > 0 && password.length >= MIN_PASSWORD && confirm === password && !busy;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await post("/setup/owner", { username: username.trim(), password });
      await onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("setup.owner.error")));
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
          <Button type="submit" disabled={!canSubmit}>
            {busy ? t("setup.owner.creating") : t("setup.owner.submit")}
          </Button>
        }
      >
        <div className="grid gap-4 sm:max-w-md">
          <div className="space-y-1.5">
            <Label htmlFor="owner-username">{t("setup.owner.username")}</Label>
            <Input
              id="owner-username"
              autoComplete="username"
              autoFocus
              spellCheck={false}
              autoCapitalize="none"
              className="font-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-password">{t("setup.owner.password")}</Label>
            <Input
              id="owner-password"
              type="password"
              autoComplete="new-password"
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-describedby="owner-password-hint"
            />
            <p id="owner-password-hint" className="text-xs text-muted-foreground">
              {tooShort
                ? t("setup.owner.tooShort", { n: MIN_PASSWORD })
                : t("setup.owner.hint", { n: MIN_PASSWORD })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-confirm">{t("setup.owner.confirm")}</Label>
            <Input
              id="owner-confirm"
              type="password"
              autoComplete="new-password"
              className="font-mono"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
            />
            {mismatch ? <p className="text-xs text-destructive">{t("setup.owner.mismatch")}</p> : null}
          </div>
        </div>
        <StepError message={error} />
      </StepFrame>
    </form>
  );
}

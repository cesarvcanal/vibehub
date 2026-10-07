import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { post } from "@/lib/api";
import { apiErrorMessage } from "@/lib/apiError";
import { useAuth } from "@/providers/auth";
import { Paths } from "@/lib/paths";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/Logo";
import { useT } from "@/i18n";

interface LocationState {
  from?: { pathname?: string };
}

/**
 * What to tell somebody the sign-in door has throttled, or null when `err` is not that.
 *
 * Past a few tries the server answers 429 with `Retry-After` in seconds (see `routes/auth.ts`) and
 * stops checking passwords until it runs out. Its `{ error }` is a fixed English sentence, and the
 * generic path would show it as-is — or worse, a person who now types the RIGHT password reads it
 * as another wrong one. So this is said in the page's language, with the wait in whole minutes
 * (rounded up: "in 0 minutes" is a lie for anything under 60s). A header that is missing or not a
 * plain number of seconds still gets the honest sentence, just without the number.
 */
function throttledMessage(err: unknown, t: (key: string, vars?: { n: number }) => string): string | null {
  const response = (err as { response?: { status?: number; headers?: Record<string, unknown> } })?.response;
  if (response?.status !== 429) return null;
  const seconds = Number(response.headers?.["retry-after"]);
  if (!Number.isFinite(seconds) || seconds <= 0) return t("auth.tooManyAttemptsLater");
  return t("auth.tooManyAttempts", { n: Math.ceil(seconds / 60) });
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshSession, refreshSetup } = useAuth();
  const t = useT();

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const from = (location.state as LocationState | null)?.from?.pathname ?? Paths.BOARD;
  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { username: username.trim(), password });
      await Promise.all([refreshSession(), refreshSetup()]);
      navigate(from, { replace: true });
    } catch (err) {
      setError(throttledMessage(err, t) ?? apiErrorMessage(err, t("auth.invalidCredentials")));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-start gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t("auth.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("auth.subtitle")}
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} noValidate className="panel space-y-4 p-5">
          <div className="space-y-1.5">
            <Label htmlFor="username">{t("auth.username")}</Label>
            <Input
              id="username"
              name="username"
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
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {busy ? t("auth.signingIn") : t("auth.signIn")}
          </Button>
        </form>

        <p className="mt-4 text-xs text-muted-foreground">
          {t("auth.forgot")}
        </p>
      </div>
    </main>
  );
}

export default LoginPage;

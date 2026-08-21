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

interface LocationState {
  from?: { pathname?: string };
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshSession, refreshSetup } = useAuth();

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
      setError(apiErrorMessage(err, "Invalid username or password"));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-start gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This install is private. Only accounts created here can reach the board.
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} noValidate className="panel space-y-4 p-5">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
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
            <Label htmlFor="password">Password</Label>
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
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-xs text-muted-foreground">
          Forgot the password? There is no reset by email — recover it from the server, where the
          data directory lives.
        </p>
      </div>
    </main>
  );
}

export default LoginPage;

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/providers/auth";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { Paths } from "@/lib/paths";
import { useT } from "@/i18n";

/**
 * Gate for everything behind a session.
 *
 * Order matters: a *fresh* install has no owner at all, so there is nothing to log into —
 * it goes to the wizard from anywhere, ahead of the login redirect.
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isFresh, isLoading } = useAuth();
  const location = useLocation();
  const t = useT();

  if (isLoading) return <FullScreenLoader label={t("common.checkingSession")} />;
  if (isFresh) return <Navigate to={Paths.SETUP} replace />;
  if (!isAuthenticated) return <Navigate to={Paths.LOGIN} state={{ from: location }} replace />;

  return <>{children}</>;
}

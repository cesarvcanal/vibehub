import { Navigate } from "react-router-dom";
import { useAuth } from "@/providers/auth";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { Paths } from "@/lib/paths";
import { useT } from "@/i18n";

/** Login lives here: a fresh install has no account to sign into, and a signed-in user has no
 *  reason to see the form again. */
export function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isFresh, isLoading } = useAuth();
  const t = useT();

  if (isLoading) return <FullScreenLoader label={t("common.checkingSession")} />;
  if (isFresh) return <Navigate to={Paths.SETUP} replace />;
  if (isAuthenticated) return <Navigate to={Paths.BOARD} replace />;

  return <>{children}</>;
}

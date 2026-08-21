import { Navigate } from "react-router-dom";
import { useAuth } from "@/providers/auth";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { Paths } from "@/lib/paths";

/** Login lives here: a fresh install has no account to sign into, and a signed-in user has no
 *  reason to see the form again. */
export function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isFresh, isLoading } = useAuth();

  if (isLoading) return <FullScreenLoader label="Checking session" />;
  if (isFresh) return <Navigate to={Paths.SETUP} replace />;
  if (isAuthenticated) return <Navigate to={Paths.BOARD} replace />;

  return <>{children}</>;
}

import { Navigate, Route, Routes } from "react-router-dom";
import { Paths } from "@/lib/paths";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { SessionGuard } from "@/components/SessionGuard";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/features/auth/LoginPage";
import { SetupWizard } from "@/features/setup/SetupWizard";
import { BoardPage } from "@/features/board/BoardPage";

export function AppRoutes() {
  return (
    <>
      <SessionGuard />
      <Routes>
        <Route
          path={Paths.LOGIN}
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        {/* Public on purpose: on a fresh install there is nobody to authenticate as yet. */}
        <Route path={Paths.SETUP} element={<SetupWizard />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path={Paths.BOARD} element={<BoardPage />} />
        </Route>
        <Route path="*" element={<Navigate to={Paths.BOARD} replace />} />
      </Routes>
    </>
  );
}

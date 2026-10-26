import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Paths } from "@/lib/paths";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { SessionGuard } from "@/components/SessionGuard";
import { AppLayout } from "@/components/AppLayout";
import { LoginPage } from "@/features/auth/LoginPage";
import { SetupWizard } from "@/features/setup/SetupWizard";
import { BoardPage } from "@/features/board/BoardPage";
import { voiceReturn } from "@/features/voice/status";
import { VoiceLabPage } from "@/features/voice/living/VoiceLabPage";

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
          {/* Voice happens INSIDE the card's chat now; an old /voice link leads back to that card. */}
          <Route path={Paths.VOICE} element={<VoiceRedirect />} />
          <Route path={Paths.VOICE_LAB} element={<VoiceLabPage />} />
        </Route>
        <Route path="*" element={<Navigate to={Paths.BOARD} replace />} />
      </Routes>
    </>
  );
}

/** `/voice?project=…&card=…` (links from before the call moved into the chat) → that card's chat. */
function VoiceRedirect() {
  return <Navigate to={voiceReturn(useLocation().search).to} replace />;
}

import { Providers } from "@/providers/providers";
import { AppRoutes } from "@/routes";
import { ParticlesBackground } from "@/components/ParticlesBackground";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function App() {
  return (
    <Providers>
      {/*
        One canvas for the whole app, mounted above the routes so it covers the signed-in shell and
        the signed-out screens (login, first-run setup) alike. It is `fixed -z-10`, so it sits over
        the body's grid and glows but under every page.
      */}
      <ParticlesBackground fixed dim={0.5} />
      {/* Inside the providers (the boundary's message is translated) and around EVERYTHING routed:
          a crash in any screen must land on a message with a way out, never on a blank page. */}
      <ErrorBoundary>
        <AppRoutes />
      </ErrorBoundary>
    </Providers>
  );
}

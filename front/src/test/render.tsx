import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/providers/auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SetupState } from "@/api/types";

/** A query client with retries and logging off, so a rejected probe fails fast and quietly. */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderAppOptions extends Omit<RenderOptions, "wrapper"> {
  route?: string;
  queryClient?: QueryClient;
}

/** Render a screen with everything the shell provides: router, query cache, auth, tooltips. */
export function renderApp(ui: ReactElement, options: RenderAppOptions = {}) {
  const { route = "/", queryClient = testQueryClient(), ...rest } = options;

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={[route]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <AuthProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...rest }) };
}

/** A fully provisioned install, as the server would report it. Override what a test cares about. */
export function setupState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    fresh: false,
    steps: { owner: true, runner: true, claude: true, github: true },
    runner: {
      running: true,
      exists: true,
      claudeInstalled: true,
      dockerReachable: true,
      container: "vibehub-runner",
    },
    ...overrides,
  };
}

/** A brand-new install with nothing done. */
export function freshState(): SetupState {
  return {
    fresh: true,
    steps: { owner: false, runner: false, claude: false, github: false },
    runner: {
      running: false,
      exists: false,
      claudeInstalled: false,
      dockerReachable: true,
      container: "vibehub-runner",
    },
  };
}

/** Build an axios-shaped rejection, the way the interceptor and apiErrorMessage expect it. */
export function apiReject(status: number, error: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error } },
  });
}

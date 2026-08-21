import * as React from "react";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { QueryProvider } from "@/providers/query";
import { AuthProvider } from "@/providers/auth";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Order matters: the router has to wrap the auth provider, because the session guard inside it
 * navigates, and the query client has to wrap both.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <TooltipProvider delayDuration={200} skipDelayDuration={300}>
            {children}
            {/* Dark to match the shell — the light palette is an explicit opt-in, not the default. */}
            <Toaster position="top-right" richColors theme="dark" />
          </TooltipProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryProvider>
  );
}

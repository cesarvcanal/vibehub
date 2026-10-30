import * as React from "react";
import type { Preview } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/providers/auth";
import { setLanguage } from "@/i18n";
import "@/index.css";

// The people who use this every day read it in Portuguese: the stories show the copy they will see.
setLanguage("pt-BR");

/**
 * A query cache per story that never goes to the network (queries off by default): stories hand
 * their data in as props. The auth provider is there for the components that ask who is signed in
 * (the request-review dialog); with the queries off, nobody is.
 */
function StoryProviders({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  // The app's own canvas (dark background, text colour) and the providers every screen expects.
  decorators: [
    (Story) => (
      <StoryProviders>
        <div className="min-h-screen bg-background p-4 text-foreground">
          <Story />
        </div>
      </StoryProviders>
    ),
  ],
};

export default preview;

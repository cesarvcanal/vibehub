import * as React from "react";
import type { Preview } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguage } from "@/i18n";
import "@/index.css";

// The people who use this every day read it in Portuguese: the stories show the copy they will see.
setLanguage("pt-BR");

/** A query cache per story that never goes to the network: stories hand their data in as props. */
function StoryProviders({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TooltipProvider>{children}</TooltipProvider>
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

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { FEATURES_KEY, cardKey, cardsKey, type BoardCard, type BoardProject } from "@/features/board/api";

/**
 * The card screen as it opens on a phone and on a desktop, from fixtures: the card bar, the native
 * chat (empty, no driver behind it) and the composer. The board's cache is seeded so the view
 * mounts straight into the chat instead of waiting for a back-end that is not there.
 *
 * Use the toolbar's viewport (or open the story in a 390–430px window) to see the phone layout.
 */

const project: BoardProject = {
  id: "p1",
  name: "vibehub",
  repoFullName: "cesarvcanal/vibehub",
  baseBranch: "main",
  position: 0,
  createdAt: 1,
};

const card: BoardCard = {
  id: "c1",
  projectId: "p1",
  title: "feat/responsividade",
  column: "working",
  position: 0,
  base: "main",
  tmuxSession: "card-abcdef12",
  worktreeSlug: "feat-responsividade-9344",
  createdAt: 1,
  openedAt: 1,
  preparedAt: 1,
};

function Seeded({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const [ready] = React.useState(() => {
    client.setQueryData(cardsKey(project.id), [card]);
    client.setQueryData(cardKey(card.id), card);
    client.setQueryData(FEATURES_KEY, { sdkChat: true });
    return true;
  });
  return ready ? <>{children}</> : null;
}

const meta: Meta<typeof CardTerminalView> = {
  title: "Board/Card",
  component: CardTerminalView,
  decorators: [
    (Story) => (
      <Seeded>
        {/* The page's own box: the full viewport height, the padding the board screen gives it. */}
        <div className="-m-4 flex h-[100dvh] flex-col p-2 md:p-4">
          <Story />
        </div>
      </Seeded>
    ),
  ],
  args: { project, cardId: card.id, onBack: () => undefined, onOpenMenu: () => undefined },
};

export default meta;

export const ChatNativo: StoryObj<typeof CardTerminalView> = {};

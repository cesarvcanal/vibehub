import { Button } from "@/components/ui/button";
import { StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";

/** Step 5 — nothing left to configure. */
export function DoneStep({ meta, onFinish }: { meta: SetupStepMeta; onFinish: () => void }) {
  return (
    <StepFrame
      title={meta.title}
      why={meta.why}
      footer={
        <Button type="button" onClick={onFinish}>
          Go to the board
        </Button>
      }
    >
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        Create a project pointing at a repository, then add a card. Each card gets its own git
        worktree and its own live Claude terminal inside the runner — the board is just where you
        watch them.
      </p>
    </StepFrame>
  );
}

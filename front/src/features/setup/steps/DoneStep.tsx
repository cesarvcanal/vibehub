import { Button } from "@/components/ui/button";
import { StepFrame } from "@/features/setup/StepFrame";
import type { SetupStepMeta } from "@/features/setup/steps";
import { useT } from "@/i18n";

/** Step 5 — nothing left to configure. */
export function DoneStep({ meta, onFinish }: { meta: SetupStepMeta; onFinish: () => void }) {
  const t = useT();
  return (
    <StepFrame
      title={meta.title}
      why={meta.why}
      footer={
        <Button type="button" onClick={onFinish}>
          {t("setup.done.goToBoard")}
        </Button>
      }
    >
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {t("setup.done.body")}
      </p>
    </StepFrame>
  );
}

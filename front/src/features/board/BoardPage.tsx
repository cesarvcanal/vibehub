import { useAuth } from "@/providers/auth";
import { Badge } from "@/components/ui/badge";
import { CARD_COLUMNS } from "@/api/types";

/**
 * PLACEHOLDER.
 *
 * The real kanban — columns, drag and drop, the embedded terminal per card — is ported
 * separately. This keeps the shell's routing honest in the meantime and shows the runner state
 * the rest of the app already knows about.
 */
export function BoardPage() {
  const { setup } = useAuth();
  const runner = setup?.runner;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Board</h1>
        {runner ? (
          <Badge tone={runner.running ? "ok" : runner.exists ? "warn" : "critical"}>
            runner {runner.running ? "running" : runner.exists ? "stopped" : "missing"}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        {CARD_COLUMNS.map((column) => (
          <section key={column} className="panel min-h-40 p-3">
            <h2 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {column}
            </h2>
          </section>
        ))}
      </div>

      <p className="mt-6 max-w-prose text-sm text-muted-foreground">
        The kanban is not wired up yet in this build.
      </p>
    </div>
  );
}

export default BoardPage;

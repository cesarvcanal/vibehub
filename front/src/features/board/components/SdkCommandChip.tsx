import { Check, Loader2, Puzzle, Sparkles, SquareTerminal } from "lucide-react";
import type { InvokedCommand } from "@/features/board/lib/slashMenu";
import { useT } from "@/i18n";

const SOURCE_ICON = { command: SquareTerminal, skill: Sparkles, plugin: Puzzle } as const;

/**
 * THE SEND THAT IS A COMMAND (`/context`, `/compact`, `/code-review high`): drawn as the command
 * it is — monospaced, with the icon of its kind (Claude Code's, skill, plugin) and its state —, and not
 * as a sentence. "executando…" while the turn it opened runs; "executado" when it closes.
 */
export function SdkCommandChip({ command, running }: { command: InvokedCommand; running: boolean }) {
  const t = useT();
  const Icon = SOURCE_ICON[command.source];
  return (
    <div
      data-testid="sdk-command"
      data-command={command.name}
      data-running={running || undefined}
      title={t(`sdk.commandSource.${command.source}`)}
      className="flex max-w-[85%] select-text items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-xs"
    >
      <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="min-w-0 whitespace-pre-wrap break-words">
        <span className="font-semibold text-primary">/{command.name}</span>
        {command.args ? <span className="text-foreground"> {command.args}</span> : null}
      </span>
      <span className="ml-1 flex shrink-0 items-center gap-1 font-sans text-[10px] text-muted-foreground">
        {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-emerald-500" />}
        {t(running ? "sdk.commandRunning" : "sdk.commandDone")}
      </span>
    </div>
  );
}

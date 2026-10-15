import * as React from "react";
import { ChevronRight, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { parseTodos, toolHeadline, type SdkRow, type SdkTodo } from "@/features/board/lib/sdkChat";

/** O símbolo de cada estado — o mesmo vocabulário da lista do Claude Code no terminal. */
const STATUS_MARK: Record<SdkTodo["status"], string> = { completed: "✓", in_progress: "●", pending: "○" };

/**
 * A LISTA DE TAREFAS DO AGENTE (um TodoWrite).
 *
 * A linha dizia só "TodoWrite" — e a lista é exatamente o plano que quem acompanha quer ler: o que
 * já foi, o que está sendo feito agora, o que falta. Cada TodoWrite é a lista INTEIRA de novo, então
 * só o mais recente (`latest`) nasce aberto: os anteriores são versões velhas e ficam recolhidos,
 * mostrando só a contagem. A escolha explícita da pessoa (abrir/fechar) vence o padrão.
 */
export function TodoCard({ row, latest }: { row: Extract<SdkRow, { kind: "tool" }>; latest: boolean }) {
  const t = useT();
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const open = choice ?? latest;
  const todos = parseTodos((row.input as { todos?: unknown } | undefined)?.todos) ?? [];
  const headline = toolHeadline(row.name, row.input);
  return (
    <div data-testid="sdk-todos" data-open={open || undefined} className="min-w-0 pl-0.5 text-xs">
      <button
        type="button"
        data-testid="sdk-todos-toggle"
        aria-expanded={open}
        aria-label={open ? t("sdk.todosHide") : t("sdk.todosShow")}
        onClick={() => setChoice(!open)}
        className="flex w-full min-w-0 items-baseline gap-1.5 rounded text-left text-muted-foreground hover:text-foreground"
      >
        <ListTodo className="h-3 w-3 shrink-0 translate-y-0.5 opacity-70" />
        <span data-testid="sdk-todos-title" className="shrink-0 font-medium text-foreground/90">
          {headline.title}
        </span>
        {!open && headline.detail ? <span className="min-w-0 truncate opacity-70">{headline.detail}</span> : null}
        <ChevronRight className={cn("h-3 w-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
      </button>
      {open && todos.length > 0 ? (
        <ul className="mt-1 space-y-0.5 pl-[1.1rem]">
          {todos.map((todo, i) => (
            <li
              key={i}
              data-testid="sdk-todo-item"
              data-status={todo.status}
              className={cn(
                "flex min-w-0 items-baseline gap-1.5",
                todo.status === "completed" && "text-muted-foreground/70 line-through",
                todo.status === "in_progress" && "font-semibold text-foreground",
                todo.status === "pending" && "text-muted-foreground",
              )}
            >
              <span aria-hidden className="w-3 shrink-0 text-center">{STATUS_MARK[todo.status]}</span>
              <span className="min-w-0 break-words">
                {todo.status === "in_progress" ? todo.activeForm || todo.content : todo.content || todo.activeForm}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

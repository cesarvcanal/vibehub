import * as React from "react";
import { ChevronDown, ChevronUp, FolderGit2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projectBaseBranch, projectRepo, type BoardProject } from "@/features/board/api";

/**
 * Selected-row accent: a hairline down the left edge and a whisper of tint. Used for the selected
 * project here and the open card in the terminal sidebar, so "this is the one" always looks the
 * same.
 */
export const SELECTED_ROW =
  "relative bg-primary/[0.06] before:absolute before:inset-y-1 before:left-0 before:z-10 before:w-[3px] before:rounded-r-full before:bg-primary/70 before:content-['']";

/**
 * The project list.
 *
 * Order is persisted (`PATCH /api/projects/:id/order`) and can be changed by dragging or, for
 * anyone who cannot drag — keyboard, touch, a trackpad having a bad day — by the up/down buttons
 * that appear on the row. The drop indicator is a LINE between rows rather than an outline on one,
 * because the question being answered is "where will it land", not "which row am I over".
 */
export function ProjectSidebar({
  projects,
  selectedId,
  onSelect,
  onReorder,
  onNewProject,
  onDeleteProject,
}: {
  projects: BoardProject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Drops project `id` at `position` — the index AFTER it has been removed, as the server wants. */
  onReorder: (id: string, position: number) => void;
  onNewProject: () => void;
  onDeleteProject: (project: BoardProject) => void;
}) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropAt, setDropAt] = React.useState<{ index: number; below: boolean } | null>(null);

  const clear = () => {
    setDraggingId(null);
    setDropAt(null);
  };

  function drop(index: number, below: boolean) {
    const id = draggingId;
    clear();
    if (!id) return;
    const from = projects.findIndex((p) => p.id === id);
    if (from === -1) return;
    const position = gapToPosition(below ? index + 1 : index, from);
    if (position !== from) onReorder(id, position);
  }

  function step(id: string, direction: -1 | 1) {
    const from = projects.findIndex((p) => p.id === id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= projects.length) return;
    onReorder(id, to);
  }

  return (
    <nav aria-label="Projects" className="panel flex flex-col overflow-hidden lg:w-60 lg:shrink-0">
      <div className="flex items-center justify-between border-b border-border/60 py-1 pl-3 pr-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="New project"
              onClick={onNewProject}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New project</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
        {projects.map((project, index) => (
          <ProjectRow
            key={project.id}
            project={project}
            index={index}
            first={index === 0}
            last={index === projects.length - 1}
            selected={project.id === selectedId}
            draggingId={draggingId}
            dropLine={
              draggingId && draggingId !== project.id && dropAt?.index === index
                ? dropAt.below
                  ? "bottom"
                  : "top"
                : null
            }
            onSelect={() => onSelect(project.id)}
            onDragStart={() => setDraggingId(project.id)}
            onDragEnd={clear}
            onHover={(i, below) => setDropAt({ index: i, below })}
            onDrop={drop}
            onStep={(direction) => step(project.id, direction)}
            onDelete={() => onDeleteProject(project)}
          />
        ))}
        {projects.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No projects yet.</p>
        ) : null}
      </div>
    </nav>
  );
}

function ProjectRow({
  project,
  index,
  first,
  last,
  selected,
  draggingId,
  dropLine,
  onSelect,
  onDragStart,
  onDragEnd,
  onHover,
  onDrop,
  onStep,
  onDelete,
}: {
  project: BoardProject;
  index: number;
  first: boolean;
  last: boolean;
  selected: boolean;
  draggingId: string | null;
  dropLine: "top" | "bottom" | null;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHover: (index: number, below: boolean) => void;
  onDrop: (index: number, below: boolean) => void;
  onStep: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const dropActive = Boolean(draggingId) && draggingId !== project.id;
  const repo = projectRepo(project);
  const branch = projectBaseBranch(project);

  const below = (e: React.DragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return isBelowMidpoint(e.clientY, rect.top, rect.height);
  };

  return (
    <div
      data-project-row={project.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", project.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={
        dropActive
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              onHover(index, below(e));
            }
          : undefined
      }
      onDrop={
        dropActive
          ? (e) => {
              e.preventDefault();
              onDrop(index, below(e));
            }
          : undefined
      }
      className={cn(
        "group relative flex items-center transition-colors",
        draggingId === project.id && "opacity-40",
        selected ? SELECTED_ROW : "hover:bg-card/60",
      )}
    >
      {dropLine ? (
        <span
          aria-hidden
          data-drop-line={dropLine}
          className={cn(
            "pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-primary",
            dropLine === "top" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}

      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 py-2.5 pl-3 pr-1 text-left active:cursor-grabbing"
      >
        <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span title={project.name} className="block truncate text-sm font-medium">
            {project.name}
          </span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {repo ?? "no repository"}
            {branch ? ` · ${branch}` : ""}
          </span>
        </span>
      </button>

      <span className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={`Delete project ${project.name}`}
          onClick={onDelete}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <span className="flex flex-col">
        <button
          type="button"
          aria-label={`Move ${project.name} up`}
          disabled={first}
          onClick={() => onStep(-1)}
          className="grid h-4 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`Move ${project.name} down`}
          disabled={last}
          onClick={() => onStep(1)}
          className="grid h-4 w-5 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        </span>
      </span>
    </div>
  );
}

/** Is the pointer in the BOTTOM half of the row it is over (drop after, rather than before)? PURE. */
export function isBelowMidpoint(pointerY: number, rectTop: number, rectHeight: number): boolean {
  return pointerY >= rectTop + rectHeight / 2;
}

/**
 * Turns a gap index (0..n, in the FULL list) into the `position` the server expects — the index
 * after the moved item has been taken out. Dropping a row back where it already is, on either side
 * of itself, is a no-op.
 */
export function gapToPosition(gap: number, from: number): number {
  if (gap === from || gap === from + 1) return from;
  return gap > from ? gap - 1 : gap;
}

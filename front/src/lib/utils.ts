import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Is this click the browser's "open it somewhere else" gesture?
 *
 * Cards and card rows are real `<a href>` elements so the operating system's habits keep working —
 * middle-click, Cmd/Ctrl-click, Shift-click. When one of those is used the handler must get out of
 * the way and let the browser follow the link; only a plain left click is ours to intercept.
 */
export function isNewTabClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button: number;
}): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
}

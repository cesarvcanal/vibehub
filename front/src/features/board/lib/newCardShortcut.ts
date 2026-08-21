/**
 * Keyboard shortcuts of the board.
 *
 * Both have to work while an xterm has focus, which is the whole difficulty: xterm keeps a hidden
 * textarea focused and swallows keystrokes, so the listener runs in CAPTURE on the window and stops
 * the event before the terminal ever sees it. A normal text field is still respected — Cmd+K in a
 * search box is not "new card".
 */

/** Cmd+K (mac) or Ctrl+K. Nothing else: Cmd+T and friends never reach the page in a browser. */
export function isNewCardShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (e.key.toLowerCase() !== "k") return false;
  return e.metaKey !== e.ctrlKey; // exactly one of them, never both
}

/** Escape with no modifiers — leaves focus mode. */
export function isLeaveFocusShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** xterm's hidden textarea: the terminal has focus and the keystroke belongs to the agent. */
export function isTerminalField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains("xterm-helper-textarea");
}

/** An ordinary text field. The terminal's textarea deliberately does NOT count as one. */
export function isPlainTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isTerminalField(target)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // Boolean(): not every DOM implementation defines the property, and undefined is not "no".
  return Boolean(target.isContentEditable);
}

/**
 * Binds "new card" on the window in capture. Returns the disposer.
 *
 * Fires from the terminal too — that is the point: you are reading an agent's output, you think of
 * the next task, and you should not have to reach for the mouse to write it down.
 */
export function attachNewCardShortcut(onTrigger: () => void, target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isNewCardShortcut(e) || isPlainTextField(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    onTrigger();
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}

/**
 * Binds "leave focus mode" (Escape) on the window in capture. Returns the disposer.
 *
 * Unlike the new-card shortcut this one does NOT fire while the terminal has focus: Escape is a key
 * the agent uses (menus, editors, interrupting a prompt), and stealing it would make the terminal
 * subtly broken. Click outside the terminal — or use the Back button — and Escape leaves.
 */
export function attachLeaveFocusShortcut(onTrigger: () => void, target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isLeaveFocusShortcut(e)) return;
    if (isPlainTextField(e.target) || isTerminalField(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    onTrigger();
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}

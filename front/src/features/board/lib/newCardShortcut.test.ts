import { describe, expect, it, vi } from "vitest";
import {
  attachLeaveFocusShortcut,
  attachNewCardShortcut,
  isLeaveFocusShortcut,
  isNewCardShortcut,
  isPlainTextField,
  isTerminalField,
} from "@/features/board/lib/newCardShortcut";

type Combo = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

function combo(key: string, modifiers: Partial<Omit<Combo, "key">> = {}): Combo {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe("isNewCardShortcut", () => {
  it("accepts Cmd+K and Ctrl+T", () => {
    expect(isNewCardShortcut(combo("k", { metaKey: true }))).toBe(true);
    expect(isNewCardShortcut(combo("K", { metaKey: true }))).toBe(true);
    expect(isNewCardShortcut(combo("t", { ctrlKey: true }))).toBe(true);
    expect(isNewCardShortcut(combo("T", { ctrlKey: true }))).toBe(true);
  });

  it("rejects a bare key, extra modifiers, and both modifiers at once", () => {
    expect(isNewCardShortcut(combo("k"))).toBe(false);
    expect(isNewCardShortcut(combo("k", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isNewCardShortcut(combo("k", { metaKey: true, altKey: true }))).toBe(false);
    expect(isNewCardShortcut(combo("k", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isNewCardShortcut(combo("t", { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it("rejects the halves that belong to the browser or to nothing", () => {
    // Cmd+T never reaches the page (Chrome opens a tab), and Ctrl+K is not one of ours.
    expect(isNewCardShortcut(combo("t", { metaKey: true }))).toBe(false);
    expect(isNewCardShortcut(combo("k", { ctrlKey: true }))).toBe(false);
    expect(isNewCardShortcut(combo("n", { ctrlKey: true }))).toBe(false);
  });
});

describe("isLeaveFocusShortcut", () => {
  it("is a bare Escape", () => {
    expect(isLeaveFocusShortcut(combo("Escape"))).toBe(true);
    expect(isLeaveFocusShortcut(combo("Escape", { shiftKey: true }))).toBe(false);
    expect(isLeaveFocusShortcut(combo("Esc"))).toBe(false);
  });
});

describe("target classification", () => {
  it("treats inputs, textareas, selects and contenteditable as text fields", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isPlainTextField(document.createElement(tag))).toBe(true);
    }
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement isContentEditable, so assert the property the code reads.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isPlainTextField(editable)).toBe(true);
  });

  it("does NOT count xterm's hidden textarea as a plain text field", () => {
    const helper = document.createElement("textarea");
    helper.classList.add("xterm-helper-textarea");
    expect(isTerminalField(helper)).toBe(true);
    expect(isPlainTextField(helper)).toBe(false);
  });

  it("says no for a plain element or nothing at all", () => {
    expect(isPlainTextField(document.createElement("div"))).toBe(false);
    expect(isPlainTextField(null)).toBe(false);
    expect(isTerminalField(null)).toBe(false);
  });
});

describe("attachNewCardShortcut", () => {
  it("fires and consumes the event, including from inside the terminal", () => {
    const onTrigger = vi.fn();
    const dispose = attachNewCardShortcut(onTrigger, window);

    const helper = document.createElement("textarea");
    helper.classList.add("xterm-helper-textarea");
    document.body.append(helper);
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true, bubbles: true });
    helper.dispatchEvent(event);

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    dispose();
    helper.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    helper.remove();
  });

  it("stays out of the way in an ordinary text field", () => {
    const onTrigger = vi.fn();
    const dispose = attachNewCardShortcut(onTrigger, window);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(onTrigger).not.toHaveBeenCalled();
    dispose();
    input.remove();
  });
});

describe("attachLeaveFocusShortcut", () => {
  it("fires on Escape from the page", () => {
    const onTrigger = vi.fn();
    const dispose = attachLeaveFocusShortcut(onTrigger, window);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onTrigger).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("leaves Escape to the agent while the terminal has focus", () => {
    const onTrigger = vi.fn();
    const dispose = attachLeaveFocusShortcut(onTrigger, window);
    const helper = document.createElement("textarea");
    helper.classList.add("xterm-helper-textarea");
    document.body.append(helper);
    helper.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onTrigger).not.toHaveBeenCalled();
    dispose();
    helper.remove();
  });
});

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A text field under the terminal: write (or paste, or drop an image) HERE, review, then send.
 *
 * Raw xterm is a poor place to compose anything longer than a command — on a phone keyboard it is
 * hopeless, and even on a desktop a pasted image path or a transcription wants a look before it
 * goes. So input ACCUMULATES in this field and only reaches the session when you confirm: Enter or
 * the Send button. Shift+Enter breaks the line, like the terminal itself. Plain pasted text stays a
 * native paste; a pasted or dropped IMAGE is uploaded and its runner path appended, ready to send.
 */
export interface TerminalComposerProps {
  /** Delivers the text to the session. The trailing carriage return is added here. */
  onSend: (text: string) => void;
  /** Uploads an image and resolves with its path inside the runner (null = nothing to append). */
  onUploadImage?: (file: File) => Promise<string | null>;
  placeholder?: string;
  className?: string;
}

/** Image files in a paste or drop payload, ignoring everything else. */
export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0) {
    for (const f of Array.from(data.files ?? [])) if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/** Appends a fragment to what is already typed, separated by a single space. PURE. */
export function appendFragment(current: string, fragment: string): string {
  const t = fragment.trim();
  if (!t) return current;
  return current ? `${current} ${t}` : t;
}

export function TerminalComposer({
  onSend,
  onUploadImage,
  placeholder = "Write here — Enter sends, Shift+Enter for a new line",
  className,
}: TerminalComposerProps) {
  const [text, setText] = React.useState("");
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  const append = React.useCallback((fragment: string) => {
    setText((prev) => appendFragment(prev, fragment));
  }, []);

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    onSend(`${value}\r`);
    setText("");
  };

  const upload = (files: File[]): void => {
    if (!onUploadImage) return;
    for (const file of files) {
      void onUploadImage(file).then((path) => {
        if (path) append(path);
      });
    }
  };

  return (
    <div data-testid="terminal-composer" className={cn("flex shrink-0 items-end gap-2", className)}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const files = imageFiles(e.clipboardData);
          if (files.length === 0) return; // plain text: the textarea's own paste
          e.preventDefault();
          upload(files);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(imageFiles(e.dataTransfer));
        }}
        placeholder={placeholder}
        rows={1}
        aria-label="Message to the terminal"
        className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-border/60 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
      />
      <Button type="button" size="sm" disabled={!text.trim()} onClick={send}>
        Send
      </Button>
    </div>
  );
}

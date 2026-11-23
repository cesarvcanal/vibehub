import * as React from "react";
import { ArrowUp, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { composeMessage } from "@/features/board/components/TerminalComposer";
import { useT } from "@/i18n";

export type SendChatMessage = (text: string) => Promise<void>;

export const ImageCommentContext = React.createContext<SendChatMessage | null>(null);

interface ImageViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  displayName: string;
  runnerPath: string;
}

export function ImageViewerDialog({ open, onOpenChange, src, displayName, runnerPath }: ImageViewerDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="image-viewer" className="flex max-h-[92vh] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{displayName}</DialogTitle>
          <DialogDescription>
            <a href={src} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t("chat.openImageInTab")}
            </a>
          </DialogDescription>
        </DialogHeader>
        <img
          src={src}
          alt={t("chat.attachedImage")}
          data-testid="image-viewer-image"
          className="mx-auto min-h-0 max-w-full flex-1 rounded-md border border-border/70 object-contain"
        />
        <ImageCommentField runnerPath={runnerPath} onSent={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImageCommentField({ runnerPath, onSent }: { runnerPath: string; onSent: () => void }) {
  const sendChatMessage = React.useContext(ImageCommentContext);
  if (!sendChatMessage) return null;
  return <ImageCommentForm runnerPath={runnerPath} sendChatMessage={sendChatMessage} onSent={onSent} />;
}

function ImageCommentForm({
  runnerPath,
  sendChatMessage,
  onSent,
}: {
  runnerPath: string;
  sendChatMessage: SendChatMessage;
  onSent: () => void;
}) {
  const t = useT();
  const [comment, setComment] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const canSend = comment.trim() !== "" && !sending;

  const send = async (): Promise<void> => {
    if (!canSend) return;
    setSending(true);
    try {
      await sendChatMessage(composeMessage(comment, [{ id: runnerPath, name: runnerPath, path: runnerPath, status: "ready" }]));
      onSent();
    } catch {
      setSending(false);
    }
  };

  return (
    <div className="flex items-end gap-2">
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
        rows={2}
        autoFocus
        placeholder={t("chat.imageCommentPlaceholder")}
        aria-label={t("chat.imageCommentPlaceholder")}
        data-testid="image-viewer-comment"
        className="block max-h-40 min-h-16 w-full resize-none overflow-y-auto rounded-md border border-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 md:text-sm"
      />
      <Button
        type="button"
        size="icon"
        aria-label={t("composer.send")}
        title={t("composer.send")}
        disabled={!canSend}
        onClick={() => void send()}
        className="h-11 w-11 shrink-0 rounded-full"
      >
        <ArrowUp className="h-5 w-5" />
      </Button>
    </div>
  );
}

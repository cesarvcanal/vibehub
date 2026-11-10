import * as React from "react";
import { ChevronRight, Clock3, Pencil, SendHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { LinkifiedText } from "@/features/board/components/ChatView";
import type { QueuedMessage } from "@/features/board/lib/sdkQueue";

/**
 * A FILA, desenhada — as mensagens escritas durante um turno, esperando de prontidão logo acima do
 * campo de texto.
 *
 * Por que aqui e não na conversa: uma bolha na conversa afirma que o Claude leu aquilo. Enquanto a
 * mensagem espera, ninguém leu nada — ela ainda é um rascunho entregue, e dizer o contrário é a
 * mentira que esta tela existe pra não contar. Na hora em que for entregue ela sai daqui e nasce
 * lá, como bolha, com recibo.
 *
 * Cada linha carrega os dois gestos que a fila promete: o lápis (volta pro campo, e SAI da fila —
 * nada de ser enviada no meio da correção) e o X (desisti dessa).
 */
function SdkQueueTrayView({
  queue,
  onEdit,
  onRemove,
  onSendNow,
}: {
  queue: readonly QueuedMessage[];
  /** Sem lápis nem "enviar agora" onde não há chat para recebê-las (o card ainda preparando). */
  onEdit?: (id: string) => void;
  onRemove: (id: string) => void;
  onSendNow?: (id: string) => void;
}) {
  const t = useT();
  return (
    <div
      data-testid="sdk-queue"
      // TETO. A bandeja é irmã do scroller da conversa num flex column: sem um limite ela cresce
      // com o texto que está esperando e espreme o `flex-1` do scroller até quase zero — uma
      // instrução de duzentas linhas empurrava a conversa inteira para fora da tela, e junto com
      // ela a única forma de acompanhar o que o agente estava dizendo (produção, 2026-09-28).
      // A espera é um aviso, não uma leitura: o que não couber rola aqui dentro.
      className="mt-1.5 flex max-h-[28vh] shrink-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-muted/40 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Clock3 className="h-3 w-3 shrink-0" />
        <span>{t("sdk.queueTitle", { n: queue.length })}</span>
        <span className="min-w-0 truncate font-normal opacity-80">{t("sdk.queueHint")}</span>
      </div>
      {queue.map((message) => (
        <div
          key={message.id}
          data-testid="sdk-queued"
          data-editing={message.editing === true || undefined}
          className={cn(
            "group flex items-start gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-background/60",
            message.editing === true && "opacity-60",
          )}
        >
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          {/* Teto TAMBÉM por mensagem: com várias na fila, uma gigante empurraria as outras para
              fora do teto da bandeja e elas sumiriam da vista. Cada uma rola no lugar dela — e o
              lápis continua sendo o caminho para lê-la inteira, no campo de texto. */}
          <span
            data-testid="sdk-queued-text"
            className="min-w-0 flex-1 max-h-24 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-foreground/90"
          >
            {/* Mesmo render da bolha: o caminho de um print colado vira a miniatura dele — esperar
                na fila lendo `/work/.uploads/…/1792-image.png` não diz qual imagem vai. */}
            <LinkifiedText text={message.text} compact />
          </span>
          {/* NO CAMPO, sendo reescrita: ela guarda o lugar dela na fila e não oferece gesto nenhum —
              o campo é que manda agora (Enter grava por cima, o X de lá desiste da correção). */}
          {message.editing === true ? (
            <span data-testid="sdk-queued-editing" className="shrink-0 pt-0.5 italic text-muted-foreground">
              {t("sdk.queueBeingEdited")}
            </span>
          ) : (
            <>
              {/* ATROPELAR A ESPERA: esta vai agora, no meio do turno. O padrão continua sendo
                  esperar — mas "para, tá errado" não é uma pergunta para daqui a dez minutos. */}
              {onSendNow ? (
                <button
                  type="button"
                  data-testid="sdk-queued-send-now"
                  aria-label={t("sdk.queueSendNow")}
                  title={t("sdk.queueSendNow")}
                  onClick={() => onSendNow(message.id)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <SendHorizontal className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t("sdk.queueSendNowShort")}</span>
                </button>
              ) : null}
              {onEdit ? (
                <button
                  type="button"
                  data-testid="sdk-queued-edit"
                  aria-label={t("sdk.queueEdit")}
                  title={t("sdk.queueEdit")}
                  onClick={() => onEdit(message.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                data-testid="sdk-queued-remove"
                aria-label={t("sdk.queueRemove")}
                title={t("sdk.queueRemove")}
                onClick={() => onRemove(message.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* Memoised: the tray only shows while a turn streams, which is when SdkChatView re-renders on
   every delta — and each queued row is now tokenised, not printed. The callbacks are stable. */
export const SdkQueueTray = React.memo(SdkQueueTrayView);

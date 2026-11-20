import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetLanguage, setLanguage } from "@/i18n";
import { LongToolWaitNotice } from "./LongToolWaitNotice";

describe("aviso do agente esperando um comando", () => {
  it("diz em português o que está rodando, há quanto tempo, e que a mensagem nova espera o comando", () => {
    setLanguage("pt-BR");
    render(<LongToolWaitNotice wait={{ rowId: "t1", what: "Espera o fim da bateria", elapsedSeconds: 190 }} onInterrupt={vi.fn()} />);
    expect(screen.getByTestId("long-tool-wait-notice")).toHaveTextContent(
      "O agente está há 3m 10s esperando um comando terminar. O que você mandar agora só é lido quando ele terminar. Comando: Espera o fim da bateria",
    );
    resetLanguage();
  });

  it("Interromper para o turno", async () => {
    const onInterrupt = vi.fn();
    render(<LongToolWaitNotice wait={{ rowId: "t1", what: "npm test", elapsedSeconds: 200 }} onInterrupt={onInterrupt} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});

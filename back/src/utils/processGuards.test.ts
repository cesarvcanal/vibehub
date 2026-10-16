import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "./logger.js";
import { logUnownedRejections } from "./processGuards.js";

/**
 * UMA PROMISE REJEITADA SEM DONO ENCERRA O NODE 24 — e o back leva junto os terminais, os chats e os
 * turnos em voo de todo mundo. O processo passa a registrar a rejeição como erro e seguir: quem
 * esqueceu o `.catch` aparece no log com o motivo, em vez de derrubar a instalação.
 */
describe("logUnownedRejections", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => { uninstall?.(); uninstall = null; vi.restoreAllMocks(); });

  it("registra a rejeição sem dono como erro, com o motivo", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    uninstall = logUnownedRejections();
    const reason = new Error("ENOSPC: no space left on device");

    process.emit("unhandledRejection", reason, Promise.resolve());

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ err: reason });
  });

  it("desinstalar devolve o processo ao comportamento padrão", () => {
    const before = process.listenerCount("unhandledRejection");
    const off = logUnownedRejections();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    off();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});

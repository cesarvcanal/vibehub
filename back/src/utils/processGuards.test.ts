import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "./logger.js";
import { logUnownedRejections } from "./processGuards.js";

/**
 * AN UNOWNED REJECTED PROMISE KILLS NODE 24 — and the back takes down with it everybody's terminals,
 * chats and in-flight turns. The process now logs the rejection as an error and carries on: whoever
 * forgot the `.catch` shows up in the log with the reason, instead of bringing down the install.
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

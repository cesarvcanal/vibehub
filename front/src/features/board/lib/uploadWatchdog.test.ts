import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStalledError, uploadWithWatchdog, type UploadAttempt } from "./uploadWatchdog";

/**
 * Produção, 2026-10-31: uma imagem colada no chat do celular ficou girando ("0 of 2 images
 * uploaded…", "Uploading image…") até a pessoa fechar e reabrir o card. Os logs do servidor
 * mostram que a requisição da página original NUNCA chegou — só o reenvio da página reaberta. Uma
 * requisição travada (conexão morta depois de o iOS pôr a aba em segundo plano) não falha nunca, e
 * sem prazo nenhum o spinner esperava por ela para sempre.
 */

const STALL = 30_000;
const PROCESSING = 45_000;

/** An attempt that never answers and only stops when aborted — the dead connection. */
function hangingAttempt(): UploadAttempt<string> {
  return ({ signal }) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

/** Like the above, but deaf to the abort too: a FileReader that never calls back. */
function deafAttempt(): UploadAttempt<string> {
  return () => new Promise<string>(() => {});
}

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const opts = { stallMs: STALL, processingMs: PROCESSING, attempts: 2 };

describe("uploadWithWatchdog", () => {
  it("an upload that answers in time just answers", async () => {
    const attempt = vi.fn<UploadAttempt<string>>(async () => "/work/.uploads/c/1-a.png");
    await expect(uploadWithWatchdog(attempt, opts)).resolves.toBe("/work/.uploads/c/1-a.png");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("a request that never moves is abandoned and sent AGAIN — the bug of the endless spinner", async () => {
    const attempt = vi
      .fn<UploadAttempt<string>>()
      .mockImplementationOnce(hangingAttempt())
      .mockImplementationOnce(async () => "/work/.uploads/c/2-a.png");
    const result = uploadWithWatchdog(attempt, opts);
    await vi.advanceTimersByTimeAsync(STALL + 1_000);
    await expect(result).resolves.toBe("/work/.uploads/c/2-a.png");
    expect(attempt).toHaveBeenCalledTimes(2);
    // The dead attempt was told to stop, so its socket is not left open behind the new one.
    expect(attempt.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("gives up after the last attempt: an ERROR (the chip's Retry), never an eternal wait", async () => {
    const attempt = vi.fn<UploadAttempt<string>>(hangingAttempt());
    const result = uploadWithWatchdog(attempt, opts);
    const settled = expect(result).rejects.toBeInstanceOf(UploadStalledError);
    await vi.advanceTimersByTimeAsync(2 * (STALL + 1_000));
    await settled;
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("an attempt deaf to the abort (a FileReader that never calls back) is abandoned all the same", async () => {
    const attempt = vi
      .fn<UploadAttempt<string>>()
      .mockImplementationOnce(deafAttempt())
      .mockImplementationOnce(async () => "/work/.uploads/c/3-a.png");
    const result = uploadWithWatchdog(attempt, opts);
    await vi.advanceTimersByTimeAsync(STALL + 1_000);
    await expect(result).resolves.toBe("/work/.uploads/c/3-a.png");
  });

  it("a SLOW upload that keeps sending bytes is not cut — only silence counts as stalled", async () => {
    let land: (path: string) => void = () => {};
    const attempt = vi.fn<UploadAttempt<string>>(
      ({ onProgress }) =>
        new Promise<string>((resolve) => {
          land = resolve;
          // 2 minutes of a slow phone network, a few bytes every 10 s.
          for (let s = 10; s <= 120; s += 10) setTimeout(() => onProgress(false), s * 1_000);
        }),
    );
    const result = uploadWithWatchdog(attempt, opts);
    await vi.advanceTimersByTimeAsync(120_000);
    land("/work/.uploads/c/4-a.png");
    await expect(result).resolves.toBe("/work/.uploads/c/4-a.png");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("once the last byte is out, the server gets its own (longer) budget to write the file", async () => {
    let land: (path: string) => void = () => {};
    const attempt = vi.fn<UploadAttempt<string>>(
      ({ onProgress }) =>
        new Promise<string>((resolve) => {
          land = resolve;
          onProgress(true); // everything sent; now the runner writes it
        }),
    );
    const result = uploadWithWatchdog(attempt, opts);
    await vi.advanceTimersByTimeAsync(STALL + 5_000); // past the stall budget, inside the processing one
    expect(attempt).toHaveBeenCalledTimes(1);
    land("/work/.uploads/c/5-a.png");
    await expect(result).resolves.toBe("/work/.uploads/c/5-a.png");
  });

  it("…but a server that never answers after the body is in is abandoned too", async () => {
    const attempt = vi
      .fn<UploadAttempt<string>>()
      .mockImplementationOnce(({ signal, onProgress }) => {
        onProgress(true);
        return hangingAttempt()({ signal, onProgress });
      })
      .mockImplementationOnce(async () => "/work/.uploads/c/6-a.png");
    const result = uploadWithWatchdog(attempt, opts);
    await vi.advanceTimersByTimeAsync(PROCESSING + 1_000);
    await expect(result).resolves.toBe("/work/.uploads/c/6-a.png");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("coming BACK to the tab after the request went stale retries at once, without waiting a tick", async () => {
    // iOS freezes timers in the background: the interval does not run while the tab is hidden, so
    // the return to the tab is the moment that has to notice the request is long dead.
    const attempt = vi
      .fn<UploadAttempt<string>>()
      .mockImplementationOnce(hangingAttempt())
      .mockImplementationOnce(async () => "/work/.uploads/c/7-a.png");
    const result = uploadWithWatchdog(attempt, opts);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 5 * 60_000); // five minutes in another app, no timer ran
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe("/work/.uploads/c/7-a.png");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("a real refusal from the server (4xx) is NOT retried — sending the same bytes again cannot help", async () => {
    const refusal = Object.assign(new Error("image is larger than 10 MB"), { response: { status: 400 } });
    const attempt = vi.fn<UploadAttempt<string>>(async () => {
      throw refusal;
    });
    await expect(uploadWithWatchdog(attempt, opts)).rejects.toBe(refusal);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("a network error with no answer at all IS retried — the connection died, not the request", async () => {
    const dropped = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    const attempt = vi
      .fn<UploadAttempt<string>>()
      .mockRejectedValueOnce(dropped)
      .mockResolvedValueOnce("/work/.uploads/c/8-a.png");
    await expect(uploadWithWatchdog(attempt, opts)).resolves.toBe("/work/.uploads/c/8-a.png");
  });

  it("leaves nothing running after it settles: no timer, no listener", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    await uploadWithWatchdog(vi.fn<UploadAttempt<string>>(async () => "p"), opts);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});

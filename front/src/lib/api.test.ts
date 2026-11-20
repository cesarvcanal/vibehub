import { describe, it, expect, vi, onTestFinished } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { api, setUnauthorizedHandler } from "./api";

function rejectWith401(config: InternalAxiosRequestConfig): Promise<never> {
  return Promise.reject(new AxiosError("Unauthorized", "ERR_BAD_REQUEST", config, undefined, {
    status: 401, statusText: "Unauthorized", data: {}, headers: {}, config,
  }));
}

describe("401 do cliente HTTP", () => {
  it.each([
    ["o relato de erro da tela não tira ninguém da sessão", "/platform-failures/screen-errors", false],
    ["uma rota comum leva ao login", "/cards", true],
  ])("%s", async (_case, url, expectsLogout) => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    onTestFinished(() => setUnauthorizedHandler(null));
    await expect(api.post(url, {}, { adapter: rejectWith401 })).rejects.toBeInstanceOf(AxiosError);
    expect(onUnauthorized).toHaveBeenCalledTimes(expectsLogout ? 1 : 0);
  });
});

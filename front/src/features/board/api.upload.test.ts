import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxiosRequestConfig } from "axios";
import { post } from "@/lib/api";
import { boardApi } from "@/features/board/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockPost = vi.mocked(post);
const CARD = "93448dcb-a882-4ec4-ad19-891e04bc9b7d";
const PATH = `/work/.uploads/${CARD}/1793454237095-img_3664.png`;

afterEach(() => {
  vi.useRealTimers();
  mockPost.mockReset();
});

/** The POST that went to a dead connection: never answers, stops only when aborted. */
function deadConnection(_url: string, _body?: unknown, config?: AxiosRequestConfig): Promise<never> {
  return new Promise((_resolve, reject) => {
    config?.signal?.addEventListener?.("abort", () =>
      reject(Object.assign(new Error("canceled"), { code: "ERR_CANCELED" })),
    );
  });
}

describe("boardApi.uploadCardImage — the request has a deadline", () => {
  it("sends the image with an abort signal and upload progress, and answers with the runner path", async () => {
    mockPost.mockResolvedValueOnce({ path: PATH });
    const file = new File(["png-bytes"], "img_3664.png", { type: "image/png" });
    await expect(boardApi.uploadCardImage(CARD, file)).resolves.toEqual({ path: PATH });
    const [url, body, config] = mockPost.mock.calls[0] ?? [];
    expect(url).toBe(`/cards/${CARD}/upload`);
    expect(body).toEqual({ name: "img_3664.png", content: btoa("png-bytes") });
    expect(config?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof config?.onUploadProgress).toBe("function");
  });

  it("a POST stuck on a dead connection is abandoned and sent again — not a spinner forever", async () => {
    vi.useFakeTimers();
    mockPost.mockImplementationOnce(deadConnection).mockResolvedValueOnce({ path: PATH });
    const file = new File(["png-bytes"], "img_3664.png", { type: "image/png" });
    const result = boardApi.uploadCardImage(CARD, file);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ path: PATH });
    expect(mockPost).toHaveBeenCalledTimes(2);
    const firstSignal = mockPost.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
  });

  it("a POST that stays dead every time ends in an ERROR the chip can show with Retry", async () => {
    vi.useFakeTimers();
    mockPost.mockImplementation(deadConnection);
    const file = new File(["png-bytes"], "img_3664.png", { type: "image/png" });
    const result = boardApi.uploadCardImage(CARD, file);
    const settled = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await settled;
  });
});

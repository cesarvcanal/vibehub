import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { get, post } from "@/lib/api";
import { CapturePrompt } from "@/features/board/components/VncPanel";

/**
 * The Chrome-style "save this login?" prompt. It shows the newest pending capture for a card and
 * saves it by id — the password is never in the component, only the opaque capture id.
 */

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

const CAP = { id: "cap1", host: "erp.multi", suggestedName: "erp.multi", username: "ada", at: 1 };

describe("CapturePrompt", () => {
  it("renders nothing when the browser is not live", () => {
    mockGet.mockResolvedValue({ captures: [CAP] });
    const { container } = renderApp(<CapturePrompt cardId="c1" active={false} />);
    expect(container.querySelector('[data-testid="capture-prompt"]')).toBeNull();
  });

  it("offers to save the newest capture and saves it BY ID (no password in play)", async () => {
    mockGet.mockResolvedValue({ captures: [CAP] });
    mockPost.mockResolvedValue({ credential: { id: "x", name: "erp.multi", type: "userpass", createdAt: 1 } });
    renderApp(<CapturePrompt cardId="c1" active />);

    expect(await screen.findByTestId("capture-prompt")).toHaveTextContent("erp.multi");
    const nameField = screen.getByLabelText("Save as") as HTMLInputElement;
    await waitFor(() => expect(nameField.value).toBe("erp.multi"));

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/cards/c1/captures/save", { captureId: "cap1", name: "erp.multi" }),
    );
  });

  it("dismisses a capture by id", async () => {
    mockGet.mockResolvedValue({ captures: [CAP] });
    mockPost.mockResolvedValue({ ok: true });
    renderApp(<CapturePrompt cardId="c1" active />);
    await screen.findByTestId("capture-prompt");
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/cards/c1/captures/dismiss", { captureId: "cap1" }),
    );
  });
});

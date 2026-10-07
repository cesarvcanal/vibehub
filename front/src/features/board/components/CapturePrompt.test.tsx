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

/** Who is looking at the card's browser, and what captures it has pending. */
function serve(role: "owner" | "member"): void {
  mockGet.mockImplementation((url: string) =>
    Promise.resolve(url === "/auth/me" ? { user: { id: "u1", username: "ada", role } } : { captures: [CAP] }),
  );
}

describe("CapturePrompt", () => {
  it("renders nothing when the browser is not live", () => {
    mockGet.mockResolvedValue({ captures: [CAP] });
    const { container } = renderApp(<CapturePrompt cardId="c1" active={false} />);
    expect(container.querySelector('[data-testid="capture-prompt"]')).toBeNull();
  });

  it("offers to save the newest capture and saves it BY ID (no password in play)", async () => {
    serve("owner");
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
    serve("owner");
    mockPost.mockResolvedValue({ ok: true });
    renderApp(<CapturePrompt cardId="c1" active />);
    await screen.findByTestId("capture-prompt");
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/cards/c1/captures/dismiss", { captureId: "cap1" }),
    );
  });

  /**
   * Saving creates a Vault credential — install-level, owner only (the route 403s anyone else). A
   * member with a work share used to get the prompt anyway, click Save, take a 403 toast, and see it
   * come back with every new capture. The question is the owner's, so only the owner is asked; the
   * capture stays pending for when the owner opens the card.
   */
  it("never asks a member — the Vault is the owner's, and saving would only 403", async () => {
    serve("member");
    renderApp(<CapturePrompt cardId="c1" active />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/auth/me"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("capture-prompt")).toBeNull();
    expect(mockGet).not.toHaveBeenCalledWith("/cards/c1/captures");
  });
});

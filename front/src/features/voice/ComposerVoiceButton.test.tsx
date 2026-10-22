import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TerminalComposer, resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import { ComposerVoiceButton } from "./ComposerVoiceButton";
import { MOBILE_QUERY } from "@/lib/useIsMobile";
import { get } from "@/lib/api";

/**
 * The card composer's voice button while the voice mode is on. Desktop: outside the field, beside
 * the dictation mic. Phone: the field's corner — EMPTY draft → blue "talk by voice", TEXT → the send
 * arrow. Either way /voice opens with the card in its URL. Off, the composer is what it always was.
 */

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
}));

const mockGet = vi.mocked(get);

function server({ voice, mic = true }: { voice: boolean; mic?: boolean }) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/voice/live") return { enabled: voice, available: voice, model: "gpt-live-1" };
    if (url === "/transcribe") return { available: mic, proofread: false, language: null };
    return {};
  });
}

function setViewport(mobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query === MOBILE_QUERY ? mobile : false,
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function VoiceRoute() {
  const location = useLocation();
  return <div data-testid="voice-page">{`${location.pathname}${location.search}`}</div>;
}

function renderInApp(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/?project=p1&card=card-1"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={children} />
            <Route path="/voice" element={<VoiceRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  resetDraftsForTesting();
  mockGet.mockReset();
  setViewport(false);
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe("composer voice button — voice mode on", () => {
  it.each([false, true])("empty draft: the blue voice button, distinct from the dictation mic (mobile=%s)", async (mobile) => {
    setViewport(mobile);
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    expect(voice).toBeEnabled();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
    // The dictation microphone is still there, a different button.
    expect(screen.getByRole("button", { name: "Record a message" })).not.toBe(voice);
  });

  it("desktop: OUTSIDE the field, beside the mic — the field keeps no corner padding", async () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    expect(screen.getByRole("textbox").parentElement).not.toContainElement(voice);
    expect(voice.parentElement).toContainElement(screen.getByRole("button", { name: "Record a message" }));
    expect(screen.getByRole("textbox").className).not.toContain("pr-14");
  });

  it("desktop: typing keeps the voice button and adds no send arrow (Enter sends)", async () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await screen.findByRole("button", { name: /talk by voice/i });
    await userEvent.type(screen.getByRole("textbox"), "roda os testes");
    expect(screen.getByRole("button", { name: /talk by voice/i })).toBeEnabled();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
  });

  it("phone: IN the field's corner, which gets room for it", async () => {
    setViewport(true);
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    expect(screen.getByRole("textbox").parentElement).toContainElement(voice);
    expect(screen.getByRole("textbox").className).toContain("pr-14");
  });

  it.each([false, true])("opens /voice with the card and project in the URL, and sends nothing (mobile=%s)", async (mobile) => {
    setViewport(mobile);
    server({ voice: true });
    const onSend = vi.fn();
    renderInApp(<TerminalComposer onSend={onSend} cardId="card-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /talk by voice/i }));
    expect(screen.getByTestId("voice-page")).toHaveTextContent("/voice?project=p1&card=card-1");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("phone: typing turns it into the send arrow, which sends normally; clearing turns it back", async () => {
    setViewport(true);
    server({ voice: true });
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderInApp(<TerminalComposer onSend={onSend} cardId="card-1" />);
    await screen.findByRole("button", { name: /talk by voice/i });
    const box = screen.getByRole("textbox");

    await user.type(box, "roda os testes");
    expect(screen.queryByRole("button", { name: /talk by voice/i })).not.toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Send message" });
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith("roda os testes");

    await user.clear(box);
    expect(await screen.findByRole("button", { name: /talk by voice/i })).toBeInTheDocument();
  });

  it("Enter on an empty field neither sends nor starts a call", async () => {
    server({ voice: true });
    const onSend = vi.fn();
    renderInApp(<TerminalComposer onSend={onSend} cardId="card-1" />);
    await screen.findByRole("button", { name: /talk by voice/i });
    await userEvent.type(screen.getByRole("textbox"), "{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-page")).not.toBeInTheDocument();
  });

  it("is keyboard reachable: Tab to it, Enter opens the conversation", async () => {
    server({ voice: true });
    const user = userEvent.setup();
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    voice.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("voice-page")).toBeInTheDocument();
  });

  it("desktop: no voice button while editing a sent message", async () => {
    server({ voice: true });
    renderInApp(
      <TerminalComposer onSend={vi.fn()} cardId="card-1" editing={{ text: "" }} onCancelEdit={vi.fn()} />,
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/voice/live"));
    await screen.findByRole("button", { name: "Record a message" });
    expect(screen.queryByRole("button", { name: /talk by voice/i })).not.toBeInTheDocument();
  });

  it("phone: while editing a sent message there is no voice button — only the arrow", async () => {
    setViewport(true);
    server({ voice: true });
    renderInApp(
      <TerminalComposer onSend={vi.fn()} cardId="card-1" editing={{ text: "" }} onCancelEdit={vi.fn()} />,
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/voice/live"));
    await screen.findByTestId("composer-send");
    expect(screen.queryByRole("button", { name: /talk by voice/i })).not.toBeInTheDocument();
  });
});

describe("composer voice button — voice mode off (regression)", () => {
  it("desktop keeps no corner button at all", async () => {
    server({ voice: false });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/voice/live"));
    expect(screen.queryByTestId("composer-voice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox").className).not.toContain("pr-14");
  });

  it("phone keeps its disabled send arrow on an empty field", async () => {
    setViewport(true);
    server({ voice: false });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/voice/live"));
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    expect(screen.queryByTestId("composer-voice")).not.toBeInTheDocument();
  });

  it("a composer outside a card never asks about voice", () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} />);
    expect(mockGet).not.toHaveBeenCalledWith("/voice/live");
  });
});

describe("ComposerVoiceButton states", () => {
  function renderButton(props: Partial<Parameters<typeof ComposerVoiceButton>[0]> = {}) {
    const onSend = vi.fn();
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ComposerVoiceButton cardId="card-1" empty sending={false} busy={false} voice onSend={onSend} {...props} />
      </MemoryRouter>,
    );
    return onSend;
  }

  it("voice is disabled while the dictation mic is busy or a message is going out", () => {
    renderButton({ busy: true });
    expect(screen.getByRole("button", { name: /talk by voice/i })).toBeDisabled();
  });

  it("the arrow shows a spinner and refuses clicks while sending", async () => {
    const onSend = renderButton({ empty: false, sending: true });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("aria-busy", "true");
    await userEvent.click(send).catch(() => undefined);
    expect(onSend).not.toHaveBeenCalled();
  });
});

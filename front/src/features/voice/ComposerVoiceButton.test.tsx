import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TerminalComposer, resetDraftsForTesting } from "@/features/board/components/TerminalComposer";
import { ComposerVoiceButton, VoiceCallContext, type VoiceCallControl } from "./ComposerVoiceButton";
import { MOBILE_QUERY } from "@/lib/useIsMobile";
import { get } from "@/lib/api";

/**
 * The card composer's voice button while the voice mode is on. Desktop: outside the field, beside
 * the dictation mic. Phone: the send arrow's seat in the field's bar — EMPTY draft → blue "talk by voice", TEXT → the send
 * arrow. Either way the call starts RIGHT HERE (the chat hosting the composer provides the control)
 * — no page change. Off, or in a composer no chat hosts a call in, the composer is what it was.
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

function control(inCall = false): VoiceCallControl {
  return { inCall, start: vi.fn(), stop: vi.fn() };
}

let call: VoiceCallControl = control();

function renderInApp(ui: ReactElement, host: VoiceCallControl | null = call) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/?project=p1&card=card-1"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={<VoiceCallContext.Provider value={host}>{children}</VoiceCallContext.Provider>} />
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
  call = control();
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

  it("desktop: OUTSIDE the field, beside the mic", async () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    expect(screen.getByRole("textbox").parentElement).not.toContainElement(voice);
    expect(voice.parentElement).toContainElement(screen.getByRole("button", { name: "Record a message" }));
  });

  it("desktop: typing keeps the voice button and adds no send arrow (Enter sends)", async () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await screen.findByRole("button", { name: /talk by voice/i });
    await userEvent.type(screen.getByRole("textbox"), "roda os testes");
    expect(screen.getByRole("button", { name: /talk by voice/i })).toBeEnabled();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
  });

  it("phone: in the field's bar, in the send arrow's seat — never over the text", async () => {
    setViewport(true);
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    expect(screen.getByTestId("composer-toolbar")).toContainElement(voice);
    expect(screen.getByRole("textbox").parentElement).not.toContainElement(voice);
  });

  it.each([false, true])("starts the call in this chat — no navigation — and sends nothing (mobile=%s)", async (mobile) => {
    setViewport(mobile);
    server({ voice: true });
    const onSend = vi.fn();
    renderInApp(<TerminalComposer onSend={onSend} cardId="card-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /talk by voice/i }));
    expect(call.start).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("desktop, during a call: the same seat ends it, and the field keeps working", async () => {
    server({ voice: true });
    call = control(true);
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderInApp(<TerminalComposer onSend={onSend} cardId="card-1" />);
    const end = await screen.findByRole("button", { name: /end voice call/i });
    expect(end).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByRole("textbox"), "manda o log{Enter}");
    expect(onSend).toHaveBeenCalledWith("manda o log");
    await user.click(end);
    expect(call.stop).toHaveBeenCalledTimes(1);
  });

  it("during a call the dictation mic is off — the call holds the microphone", async () => {
    server({ voice: true });
    call = control(true);
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await screen.findByRole("button", { name: /end voice call/i });
    expect(screen.getByRole("button", { name: "Record a message" })).toBeDisabled();
  });

  it("phone, during a call: the bar's seat is the send arrow (the call's controls are in its strip)", async () => {
    setViewport(true);
    server({ voice: true });
    call = control(true);
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    expect(await screen.findByTestId("composer-send")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /talk by voice/i })).not.toBeInTheDocument();
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
    expect(call.start).not.toHaveBeenCalled();
  });

  it("is keyboard reachable: Tab to it, Enter starts the call", async () => {
    server({ voice: true });
    const user = userEvent.setup();
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    const voice = await screen.findByRole("button", { name: /talk by voice/i });
    voice.focus();
    await user.keyboard("{Enter}");
    expect(call.start).toHaveBeenCalledTimes(1);
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
  it("desktop keeps no voice or send button at all", async () => {
    server({ voice: false });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/voice/live"));
    expect(screen.queryByTestId("composer-voice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
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

  it("a composer in a chat that hosts no call (the older transcript chat) offers no voice", async () => {
    server({ voice: true });
    renderInApp(<TerminalComposer onSend={vi.fn()} cardId="card-1" />, null);
    await screen.findByRole("button", { name: "Record a message" });
    expect(mockGet).not.toHaveBeenCalledWith("/voice/live");
    expect(screen.queryByTestId("composer-voice")).not.toBeInTheDocument();
  });
});

describe("ComposerVoiceButton states", () => {
  function renderButton(props: Partial<Parameters<typeof ComposerVoiceButton>[0]> = {}) {
    const onSend = vi.fn();
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ComposerVoiceButton control={control()} empty sending={false} busy={false} voice onSend={onSend} {...props} />
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

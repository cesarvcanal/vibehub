import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TerminalComposer,
  appendFragment,
  barHeights,
  formatElapsed,
  imageFiles,
  levelFromTimeDomain,
  pickAudioMimeType,
} from "./TerminalComposer";
import { get, post } from "@/lib/api";
import { MOBILE_QUERY } from "@/lib/useIsMobile";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  }),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);

/** The composer only needs a query cache; the rest of the shell is not its business. */
function renderComposer(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(ui, { wrapper: Wrapper });
}

describe("appendFragment", () => {
  it("joins fragments with one space and ignores blanks", () => {
    expect(appendFragment("", "  hello ")).toBe("hello");
    expect(appendFragment("hello", "world")).toBe("hello world");
    expect(appendFragment("hello", "   ")).toBe("hello");
  });
});

describe("imageFiles", () => {
  it("keeps only images from a transfer payload", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    const data = { items: [], files: [png, txt] } as unknown as DataTransfer;
    expect(imageFiles(data)).toEqual([png]);
    expect(imageFiles(null)).toEqual([]);
  });
});

describe("levelFromTimeDomain and barHeights", () => {
  it("reads silence as nothing — 128 is the zero line of a time-domain buffer", () => {
    expect(levelFromTimeDomain(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(levelFromTimeDomain(new Uint8Array())).toBe(0);
  });

  it("saturates on a loud signal rather than overflowing the bars", () => {
    expect(levelFromTimeDomain(new Uint8Array([0, 255, 0, 255]))).toBe(1);
  });

  it("never lets a bar disappear, and never lets one overflow", () => {
    expect(barHeights(0).every((h) => h > 0)).toBe(true);
    expect(barHeights(1).every((h) => h <= 1)).toBe(true);
    expect(barHeights(1)).toHaveLength(5);
  });
});

describe("pickAudioMimeType", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the first format the browser admits to supporting", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t === "audio/mp4" });
    // Safari records mp4 and nothing else; hard-coding webm is an iPhone that records silence.
    expect(pickAudioMimeType()).toBe("audio/mp4");
  });

  it("lets the browser decide when it claims none of them", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickAudioMimeType()).toBeUndefined();
    vi.stubGlobal("MediaRecorder", undefined);
    expect(pickAudioMimeType()).toBeUndefined();
  });
});

describe("TerminalComposer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGet.mockResolvedValue({ available: false, proofread: false, language: null });
  });

  it("sends on Enter with a carriage return and clears the field", async () => {
    const onSend = vi.fn();
    renderComposer(<TerminalComposer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: /enter sends/i });
    await userEvent.type(box, "run the tests{Enter}");
    expect(onSend).toHaveBeenCalledWith("run the tests\r");
    expect(box).toHaveValue("");
  });

  it("Shift+Enter breaks the line instead of sending", async () => {
    const onSend = vi.fn();
    renderComposer(<TerminalComposer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: /enter sends/i });
    await userEvent.type(box, "first{Shift>}{Enter}{/Shift}second");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("first\nsecond");
  });

  it("has no Send button at all — Enter is the only way, and the field keeps the width", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send|enviar/i })).not.toBeInTheDocument();
  });

  it("says how to send in the label, since there is no longer a button that says it", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveAccessibleName(/Enter sends/i);
  });

  it("never sends whitespace", async () => {
    const onSend = vi.fn();
    renderComposer(<TerminalComposer onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a pasted image is uploaded and its path accumulates — nothing is sent by itself", async () => {
    const onSend = vi.fn();
    const onUploadImage = vi.fn(async () => "/work/.uploads/c1/shot.png");
    renderComposer(<TerminalComposer onSend={onSend} onUploadImage={onUploadImage} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "look at this");
    const png = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { items: [], files: [png] } });
    await waitFor(() => expect(box).toHaveValue("look at this /work/.uploads/c1/shot.png"));
    expect(onUploadImage).toHaveBeenCalledWith(png);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a pasted plain text goes through the textarea's own paste", async () => {
    const onUploadImage = vi.fn(async () => null);
    renderComposer(<TerminalComposer onSend={vi.fn()} onUploadImage={onUploadImage} />);
    const box = screen.getByRole("textbox");
    fireEvent.paste(box, { clipboardData: { items: [], files: [] } });
    expect(onUploadImage).not.toHaveBeenCalled();
  });

  it("offers no microphone at all when there is no card to transcribe against", async () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    expect(screen.queryByTestId("composer-mic")).not.toBeInTheDocument();
  });

  it("says nothing in the placeholder — the label is for screen readers, not for the screen", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    const box = screen.getByRole("textbox");
    // A grey sentence explaining what a text box is competes with the agent's output all day.
    expect(box).toHaveAttribute("placeholder", "");
    expect(box).toHaveAccessibleName("Write here — Enter sends, Shift+Enter starts a new line");
  });

  it("opens at about three lines and grows no further than max-h-48", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    const box = screen.getByRole("textbox");
    expect(box).toHaveAttribute("rows", "3");
    expect(box.className).toContain("min-h-24");
    expect(box.className).toContain("max-h-48");
    // Solid, not a wash: the field is where you write, and it should look like a field.
    expect(box.className).toContain("bg-card");
    expect(box.className).not.toContain("bg-card/50");
  });
});

/* ------------------------------------------------------------ voice input */

class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";

  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
    FakeRecorder.last = this;
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

describe("TerminalComposer — voice input", () => {
  const stopTrack = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    FakeRecorder.last = null;
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function serveVoice(available: boolean) {
    mockGet.mockImplementation((url: string) =>
      url === "/transcribe"
        ? Promise.resolve({ available, proofread: false, language: null })
        : Promise.resolve({}),
    );
  }

  it("disables the microphone and says why when the install has no key", async () => {
    serveVoice(false);
    renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" />);

    const mic = await screen.findByTestId("composer-mic");
    // A button that fails when pressed teaches nothing; this one names the missing piece.
    await waitFor(() => expect(mic).toBeDisabled());
    expect(mic).toHaveAttribute(
      "title",
      "Voice input is not configured — add an OpenAI key in Settings",
    );
  });

  it("keeps the placeholder empty even once recording is configured", async () => {
    serveVoice(true);
    renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" />);
    await screen.findByTestId("composer-mic");
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "");
  });

  it("transcribes a finished recording INTO the field, and sends nothing", async () => {
    serveVoice(true);
    mockPost.mockResolvedValue({ text: "run the failing test again", proofread: true });
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderComposer(<TerminalComposer onSend={onSend} cardId="c1" />);

    const box = screen.getByRole("textbox");
    await user.type(box, "then");
    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeEnabled());
    await user.click(screen.getByTestId("composer-mic"));

    // Recording: two exits, not one toggle.
    const finish = await screen.findByTestId("composer-mic-finish");
    expect(screen.getByTestId("composer-mic-cancel")).toBeInTheDocument();
    await user.click(finish);

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        "/cards/c1/transcribe",
        // The container the recorder actually produced travels with the bytes — the server hands it
        // straight to the recogniser, and Safari's mp4 is not webm.
        expect.objectContaining({
          mimeType: expect.stringContaining("audio/webm"),
          base64: expect.any(String),
        }),
      ),
    );
    // Appended, not sent: the whole point of the field is that you read it first.
    await waitFor(() => expect(box).toHaveValue("then run the failing test again"));
    expect(onSend).not.toHaveBeenCalled();
    // And back to a plain microphone, with the stream released.
    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeInTheDocument());
    expect(stopTrack).toHaveBeenCalled();
  });

  it("ends a recording when you switch to another card — the pane stays mounted, the microphone does not", async () => {
    // Card views are no longer unmounted when you look at another card (that is what keeps the
    // session attached), so leaving one has to end the recording explicitly.
    serveVoice(true);
    const user = userEvent.setup();
    const { rerender } = renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" active />);

    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeEnabled());
    await user.click(screen.getByTestId("composer-mic"));
    await screen.findByTestId("composer-mic-cancel");

    rerender(<TerminalComposer onSend={vi.fn()} cardId="c1" active={false} />);

    // Back to a plain microphone, nothing uploaded, nothing written: a cancel, not a finish.
    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeInTheDocument());
    expect(FakeRecorder.last?.state).toBe("inactive");
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("discards a cancelled recording without uploading anything", async () => {
    serveVoice(true);
    const user = userEvent.setup();
    renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" />);

    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeEnabled());
    await user.click(screen.getByTestId("composer-mic"));
    await user.click(await screen.findByTestId("composer-mic-cancel"));

    await waitFor(() => expect(screen.getByTestId("composer-mic")).toBeInTheDocument());
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});

describe("formatElapsed", () => {
  it("is m:ss, with the seconds always padded", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(4_200)).toBe("0:04");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(600_000)).toBe("10:00");
  });

  it("never goes negative on a clock that jumped backwards", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

/**
 * The phone composer.
 *
 * Two reports in one: the keyboard zoomed the page in and would not zoom back out, and the two
 * buttons were too small to hit. The first is a font size — iOS Safari zooms any focused field
 * under 16px — and the second is a target size, so both are asserted as classes rather than as
 * pixels, which jsdom does not have.
 */
describe("TerminalComposer — on a phone", () => {
  const originalMatchMedia = window.matchMedia;

  function setViewport(mobile: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches: query === MOBILE_QUERY ? mobile : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  beforeEach(() => {
    mockGet.mockResolvedValue({ available: true });
    setViewport(true);
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("writes at 16px below md, which is what stops iOS zooming the page on focus", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Write here — Enter sends, Shift+Enter starts a new line" });
    expect(field.className).toContain("text-base");
    // …and the desktop keeps the 14px it always had.
    expect(field.className).toContain("md:text-sm");
  });

  it("gives the microphone a 48px target on a phone and 36px on a desktop", async () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" />);
    const mic = await screen.findByTestId("composer-mic");
    expect(mic.className).toContain("h-12");
    expect(mic.className).toContain("w-12");
    expect(mic.className).toContain("md:h-9");
  });

  it("centres the microphone against the field instead of hanging it off the bottom", () => {
    renderComposer(<TerminalComposer onSend={vi.fn()} cardId="c1" />);
    // The field grows with the text; a bottom-aligned 48px circle drifts away from it as it does.
    expect(screen.getByTestId("terminal-composer").className).toContain("items-center");
    expect(screen.getByTestId("terminal-composer").className).not.toContain("items-end");
  });

  it("still sends on Enter, which is now the only way", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderComposer(<TerminalComposer onSend={onSend} />);
    await user.type(screen.getByRole("textbox"), "deploy{Enter}");
    expect(onSend).toHaveBeenCalledWith("deploy\r");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Markdown } from "@/features/board/components/ChatView";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Passthrough with a counter: the render is the real one, and the PARSE count is observable.
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return { ...actual, default: vi.fn(actual.default) };
});

/**
 * The agent's answer, as the person actually sees it.
 *
 * These assert RENDERED structure rather than tokens, because that is where the bug was: the old
 * hand-rolled parser had perfectly good unit tests and still printed `|---|---|` at the user, since
 * it had no concept of a table to have a test for.
 */
describe("Markdown — GFM", () => {
  it("renders a table as a TABLE, separator row and all", () => {
    const text = ["| Filial | Vendas |", "| --- | ---: |", "| CD | 120 |", "| Loja 2 | 80 |"].join("\n");
    const { container } = render(<Markdown text={text} />);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("Filial")).toBeInTheDocument();
    expect(screen.getByText("Loja 2")).toBeInTheDocument();
    // The whole point: the pipes and the dashes never reach the screen.
    expect(container.textContent).not.toContain("---");
    expect(container.textContent).not.toContain("|");
  });

  it("honours column alignment from the separator row", () => {
    const text = ["| a | b |", "| :-- | --: |", "| 1 | 2 |"].join("\n");
    const { container } = render(<Markdown text={text} />);
    const headers = container.querySelectorAll("th");
    expect((headers[0] as HTMLElement).style.textAlign).toBe("left");
    expect((headers[1] as HTMLElement).style.textAlign).toBe("right");
  });

  it("puts a wide table in its own horizontal scroller, not the transcript's", () => {
    const { container } = render(<Markdown text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />);
    const wrapper = container.querySelector("table")?.parentElement;
    expect(wrapper?.className).toContain("overflow-x-auto");
  });

  it("renders ~~strikethrough~~, task lists and bare autolinks — the rest of GFM", () => {
    const { container } = render(
      <Markdown text={"~~cancelado~~\n\n- [x] feito\n- [ ] pendente\n\nvai em https://x.dev/a, ok"} />,
    );
    expect(container.querySelector("del")?.textContent).toBe("cancelado");
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
    const link = container.querySelector("a[href]") as HTMLAnchorElement;
    // Trailing sentence punctuation stays out of the href.
    expect(link.getAttribute("href")).toBe("https://x.dev/a");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("still renders the CommonMark it always did", () => {
    const { container } = render(
      <Markdown text={"## Plano\n\nVou **fazer** assim com `api.ts`:\n\n- um\n- dois\n\n```ts\nconst a = 1;\n```"} />,
    );
    expect(screen.getByText("Plano")).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("fazer");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
  });

  it("keeps a single newline a line break — a chat is not a document", () => {
    const { container } = render(<Markdown text={"uma linha\noutra linha"} />);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("renders an unclosed fence as code — the message may still be arriving", () => {
    const { container } = render(<Markdown text={"```\nhalf a diff"} />);
    expect(container.querySelector("pre code")?.textContent).toContain("half a diff");
  });

  it("interprets nothing inside a fence", () => {
    const { container } = render(<Markdown text={"```bash\n# not a heading\n| not | a table |\n```"} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("| not | a table |");
  });

  it("links the panel's own relative preview paths, which GFM's autolink does not", () => {
    const { container } = render(<Markdown text={"no ar em /preview/3100/ — abre aí"} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/preview/3100/");
  });

  it("does not linkify a preview path inside code", () => {
    const { container } = render(<Markdown text={"roda `curl /preview/3100/x` aí"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("curl /preview/3100/x");
  });
});

describe("Markdown — safety", () => {
  it("shows raw HTML as inert TEXT instead of running it or swallowing it", () => {
    const { container } = render(<Markdown text={'antes <img src=x onerror="alert(1)"> <b>bold</b> depois'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // Swallowing it would be safe but dishonest — the person must see what the agent wrote.
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.textContent).toContain("onerror");
  });

  it("neutralises a <script> block the same way", () => {
    const { container } = render(<Markdown text={"<script>alert(1)</script>"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("NEVER produces an href for a hostile scheme — the text survives, the link does not", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd"]) {
      const { container, unmount } = render(<Markdown text={`[clica](${hostile})`} />);
      expect(container.querySelector("a[href]")).toBeNull();
      expect(container.textContent).toContain("clica");
      unmount();
    }
  });

  it("is TOTAL: an empty or undefined message renders nothing and throws nothing", () => {
    expect(() => render(<Markdown text="" />)).not.toThrow();
    expect(() => render(<Markdown text={undefined as unknown as string} />)).not.toThrow();
  });
});

/**
 * A live chat re-renders its transcript on EVERY streamed token. Markdown is the expensive part of a
 * row (remark parse + the whole plugin chain), and a message that did not change has nothing new
 * to parse — so the same text never reaches the parser twice.
 */
describe("Markdown — custo", () => {
  it("o mesmo texto não é re-parseado quando o pai redesenha", () => {
    const parses = vi.mocked(ReactMarkdown);
    parses.mockClear();
    const { rerender } = render(<Markdown text="**resposta antiga**" />);
    rerender(<Markdown text="**resposta antiga**" />);
    rerender(<Markdown text="**resposta antiga**" />);
    expect(parses).toHaveBeenCalledTimes(1);
    rerender(<Markdown text="**resposta nova**" />);
    expect(parses).toHaveBeenCalledTimes(2);
  });
});

/**
 * The agent hands you a prompt (or a command, a config) inside a fenced block, and THAT block is
 * what you want — not the whole answer around it. Selecting it by hand over a long block is
 * miserable, so each block carries its own copy button, and a toast says it worked.
 */
describe("Markdown — copiar bloco de código", () => {
  const PROMPT = "COMO TRABALHAR\n\n1. NÃO comece codando.\n   Leia o código citado acima.\n2. Commits atômicos.";
  const ANSWER = ["Segue o prompt pro César:", "", "```", PROMPT, "```", "", "Dois avisos sobre o que coloquei aí."].join("\n");
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("copia SÓ o conteúdo do bloco, exatamente como a IA escreveu, e avisa com um toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={ANSWER} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // The block, untouched: indentation and blank lines kept, no fences, none of the prose around it.
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied to clipboard", { id: "chat-code-copied" }));
    // The button itself also confirms, for whoever is not looking at the corner of the screen.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("cada bloco tem o seu botão e copia o SEU texto", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"```bash\nnpm test\n```\n\nentre eles\n\n```ts\nconst a = 1;\n```"} />);

    const buttons = screen.getAllByRole("button", { name: "Copy code" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;"));
  });

  it("código inline NÃO ganha botão — é um trecho da frase, não um bloco", () => {
    render(<Markdown text={"rode `npm test` e depois `npm run build`"} />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("sem Clipboard API (painel em http), cai no execCommand e ainda copia", async () => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    let copied = "";
    const execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<Markdown text={"```\nfaz isso\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(copied).toBe("faz isso");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied to clipboard", { id: "chat-code-copied" }));
  });

  it("o fallback devolve o foco a quem tinha — copiar não fecha o teclado do composer", async () => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => true), configurable: true });
    render(
      <>
        <textarea aria-label="composer" />
        <Markdown text={"```\nfaz isso\n```"} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "composer" });
    composer.focus();

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(document.activeElement).toBe(composer);
  });

  it("cliques seguidos substituem o toast em vez de empilhar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"```\nfaz isso\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copied" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    const ids = vi.mocked(toast.success).mock.calls.map((call) => (call[1] as { id?: unknown } | undefined)?.id);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
  });

  it("bloco vazio não ganha botão — não há nada para copiar", () => {
    render(<Markdown text={"```\n```"} />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("desmontar no meio da cópia não deixa timer vivo", async () => {
    vi.useFakeTimers();
    try {
      let resolve: () => void = () => {};
      const writeText = vi.fn(() => new Promise<void>((r) => (resolve = r)));
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const { unmount } = render(<Markdown text={"```\nfaz isso\n```"} />);

      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      unmount();
      resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quando nada chega ao clipboard, diz que falhou — nunca um 'copiado' mentiroso", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true });
    render(<Markdown text={"```\nfaz isso\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not copy"));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

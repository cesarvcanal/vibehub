import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "@/features/board/components/ChatView";

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

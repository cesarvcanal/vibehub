import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { BASE_TITLE, boardTitle, useDocumentTitle } from "@/features/board/lib/documentTitle";

describe("boardTitle", () => {
  it("leads with the card, because that is what you are looking for in a tab strip", () => {
    expect(boardTitle("billing", "fix the totals")).toBe("fix the totals · billing");
  });

  it("falls back to the project, then to the app", () => {
    expect(boardTitle("billing")).toBe(`billing · ${BASE_TITLE}`);
    expect(boardTitle()).toBe(BASE_TITLE);
    expect(boardTitle(null, "orphan card")).toBe(BASE_TITLE);
  });

  it("trims, and treats blank as absent", () => {
    expect(boardTitle("  billing  ", "  fix  ")).toBe("fix · billing");
    expect(boardTitle("   ")).toBe(BASE_TITLE);
  });
});

function Titled({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

describe("useDocumentTitle", () => {
  it("sets the title while mounted", () => {
    document.title = "before";
    render(<Titled title="while mounted" />);
    expect(document.title).toBe("while mounted");
    cleanup();
  });

  it("follows the text as it changes", () => {
    const view = render(<Titled title="first" />);
    view.rerender(<Titled title="renamed" />);
    expect(document.title).toBe("renamed");
    cleanup();
  });

  it("restores what was there before, so a title never leaks into the next screen", () => {
    document.title = "the board";
    const view = render(<Titled title="a card" />);
    view.rerender(<Titled title="the same card, renamed" />);
    view.unmount();
    expect(document.title).toBe("the board");
  });
});

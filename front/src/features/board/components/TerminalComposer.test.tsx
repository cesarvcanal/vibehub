import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalComposer, appendFragment, imageFiles } from "./TerminalComposer";

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

describe("TerminalComposer", () => {
  it("sends on Enter with a carriage return and clears the field", async () => {
    const onSend = vi.fn();
    render(<TerminalComposer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: /message to the terminal/i });
    await userEvent.type(box, "run the tests{Enter}");
    expect(onSend).toHaveBeenCalledWith("run the tests\r");
    expect(box).toHaveValue("");
  });

  it("Shift+Enter breaks the line instead of sending", async () => {
    const onSend = vi.fn();
    render(<TerminalComposer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: /message to the terminal/i });
    await userEvent.type(box, "first{Shift>}{Enter}{/Shift}second");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("first\nsecond");
  });

  it("the Send button is disabled while the field is blank", async () => {
    render(<TerminalComposer onSend={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "x");
    expect(button).toBeEnabled();
  });

  it("never sends whitespace", async () => {
    const onSend = vi.fn();
    render(<TerminalComposer onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a pasted image is uploaded and its path accumulates — nothing is sent by itself", async () => {
    const onSend = vi.fn();
    const onUploadImage = vi.fn(async () => "/work/.uploads/c1/shot.png");
    render(<TerminalComposer onSend={onSend} onUploadImage={onUploadImage} />);
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
    render(<TerminalComposer onSend={vi.fn()} onUploadImage={onUploadImage} />);
    const box = screen.getByRole("textbox");
    fireEvent.paste(box, { clipboardData: { items: [], files: [] } });
    expect(onUploadImage).not.toHaveBeenCalled();
  });
});

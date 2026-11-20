import { describe, it, expect, vi, onTestFinished } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function CrashingScreen(): never {
  throw new Error("Cannot read properties of undefined (reading 'title')");
}

describe("ErrorBoundary", () => {
  it("render que quebra mostra o erro na tela e o entrega a quem relata", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => { consoleError.mockRestore(); });
    const onCrash = vi.fn();
    render(<ErrorBoundary onCrash={onCrash}><CrashingScreen /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("reading 'title'");
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({ message: "Cannot read properties of undefined (reading 'title')" }));
  });
});

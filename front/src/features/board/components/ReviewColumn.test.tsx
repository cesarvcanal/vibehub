import { describe, expect, it, onTestFinished } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { REVIEW_WIDTH_STORAGE_KEY, ReviewColumn } from "@/features/board/components/ReviewColumn";

const ROW_WIDTH = 1400;

function renderColumn() {
  onTestFinished(() => localStorage.clear());
  render(
    <div data-testid="row">
      <ReviewColumn>
        <p>painel</p>
      </ReviewColumn>
    </div>,
  );
  const row = screen.getByTestId("row");
  Object.defineProperty(row, "clientWidth", { value: ROW_WIDTH });
  const column = screen.getByTestId("review-column");
  column.getBoundingClientRect = () => ({ right: ROW_WIDTH }) as DOMRect;
  return { column, handle: screen.getByRole("separator") };
}

function firePointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  const event = target instanceof Element ? createEvent.pointerDown(target) : new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "button", { value: 0 });
  fireEvent(target as Element, event);
}

function drag(handle: HTMLElement, clientX: number) {
  firePointer(handle, "pointerdown", 0);
  firePointer(window, "pointermove", clientX);
  firePointer(window, "pointerup", clientX);
}

const widthOf = (column: HTMLElement) => column.style.getPropertyValue("--review-width");

describe("ReviewColumn", () => {
  it("sem largura gravada, a coluna fica no padrão do CSS", () => {
    const { column } = renderColumn();
    expect(widthOf(column)).toBe("");
  });

  it("arrastar a borda muda a largura e grava no navegador", () => {
    const { column, handle } = renderColumn();
    drag(handle, 700);
    expect(widthOf(column)).toBe("700px");
    expect(localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY)).toBe("700");
  });

  it.each([
    ["não fica mais estreita que o mínimo", 1300, "384px"],
    ["deixa sempre espaço pro terminal", 0, "1080px"],
  ])("%s", (_name, clientX, width) => {
    const { column, handle } = renderColumn();
    drag(handle, clientX);
    expect(widthOf(column)).toBe(width);
  });

  it("a largura gravada vale ao abrir de novo", () => {
    localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, "640");
    const { column } = renderColumn();
    expect(widthOf(column)).toBe("640px");
  });

  it("largura gravada que não é número é ignorada", () => {
    localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, "largo");
    const { column } = renderColumn();
    expect(widthOf(column)).toBe("");
  });

  it("pelo teclado, a seta para a esquerda alarga e a para a direita estreita", () => {
    localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, "640");
    const { column, handle } = renderColumn();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthOf(column)).toBe("672px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthOf(column)).toBe("608px");
    expect(localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY)).toBe("608");
  });

  it("duplo clique na borda volta ao padrão e apaga a largura gravada", () => {
    localStorage.setItem(REVIEW_WIDTH_STORAGE_KEY, "640");
    const { column, handle } = renderColumn();
    fireEvent.doubleClick(handle);
    expect(widthOf(column)).toBe("");
    expect(localStorage.getItem(REVIEW_WIDTH_STORAGE_KEY)).toBeNull();
  });
});

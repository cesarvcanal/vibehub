import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { REVIEW_WIDTH_STORAGE_KEY, ReviewColumn } from "@/features/board/components/ReviewColumn";

const ROW_WIDTH = 1400;
const RENDERED_WIDTH = 500;

function renderColumn({ besidePanes = 1 }: { besidePanes?: number } = {}) {
  onTestFinished(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(ROW_WIDTH);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ right: ROW_WIDTH, width: RENDERED_WIDTH } as DOMRect);
  render(
    <div>
      <ReviewColumn besidePanes={besidePanes}>
        <p>painel</p>
      </ReviewColumn>
    </div>,
  );
  return { column: screen.getByTestId("review-column"), handle: screen.getByRole("separator") };
}

function withPointer(event: Event, clientX: number): Event {
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "button", { value: 0 });
  return event;
}

function drag(handle: HTMLElement, clientX: number) {
  fireEvent(handle, withPointer(createEvent.pointerDown(handle), 0));
  fireEvent(window, withPointer(new Event("pointermove"), clientX));
  fireEvent(window, withPointer(new Event("pointerup"), clientX));
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

  it("com o navegador aberto ao lado, a reserva vale para o terminal e para o navegador", () => {
    const { column, handle } = renderColumn({ besidePanes: 2 });
    drag(handle, 0);
    expect(widthOf(column)).toBe("760px");
    expect(column.style.getPropertyValue("--review-beside-reserve")).toBe("640px");
  });

  it("a borda anuncia a largura atual e os limites dela", () => {
    const { handle } = renderColumn();
    expect(handle).toHaveAttribute("aria-valuemin", "384");
    expect(handle).toHaveAttribute("aria-valuemax", "1080");
    expect(handle).toHaveAttribute("aria-valuenow", String(RENDERED_WIDTH));
  });

  it("sem largura gravada, o teclado parte da largura que está na tela", () => {
    const { column, handle } = renderColumn();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthOf(column)).toBe(`${RENDERED_WIDTH + 32}px`);
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

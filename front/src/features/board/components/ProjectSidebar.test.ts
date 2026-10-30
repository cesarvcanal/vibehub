import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ProjectSidebar, gapToPosition, isBelowMidpoint } from "@/features/board/components/ProjectSidebar";
import type { BoardCard, BoardProject } from "@/features/board/api";
import { renderApp, setupState } from "@/test/render";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import { get } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

describe("isBelowMidpoint", () => {
  it("is the bottom half that means 'drop after this row'", () => {
    expect(isBelowMidpoint(30, 0, 40)).toBe(true);
    expect(isBelowMidpoint(10, 0, 40)).toBe(false);
  });

  it("counts the exact midpoint as below, so there is no dead zone", () => {
    expect(isBelowMidpoint(20, 0, 40)).toBe(true);
  });

  it("works away from the top of the page", () => {
    expect(isBelowMidpoint(510, 500, 40)).toBe(false);
    expect(isBelowMidpoint(530, 500, 40)).toBe(true);
  });
});

describe("gapToPosition", () => {
  it("accounts for the moved row being taken out first", () => {
    // Moving row 0 into the gap after row 2: once row 0 is removed, that gap is index 2.
    expect(gapToPosition(3, 0)).toBe(2);
  });

  it("leaves a gap above the moved row alone", () => {
    expect(gapToPosition(1, 3)).toBe(1);
  });

  it("is a no-op on either side of the row itself", () => {
    expect(gapToPosition(2, 2)).toBe(2);
    expect(gapToPosition(3, 2)).toBe(2);
  });
});

/**
 * The PR line under a card: "↳ PR #N · estado", a second link of the same row. The card keeps its
 * own link, drag source and context menu; the line only adds a way to land in the card with the
 * review's panel open.
 */
describe("ProjectSidebar — a linha do PR embaixo do card", () => {
  const mockGet = vi.mocked(get);
  const project: BoardProject = {
    id: "p1", name: "billing", repoFullName: "acme/billing", baseBranch: "dev", position: 0, createdAt: 1,
  };

  function card(id: string, title: string, review?: BoardCard["review"]): BoardCard {
    return {
      id, projectId: "p1", title, column: "working", position: 0, base: "dev", tmuxSession: `card-${id}`,
      worktreeSlug: id, createdAt: 1, openedAt: 2, ...(review ? { review } : {}),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    setLanguage("pt-BR");
  });
  afterEach(() => {
    // Unmount BEFORE the language flips back: a mounted `useT()` would re-render outside act().
    cleanup();
    setLanguage("en");
    localStorage.removeItem(LANGUAGE_KEY);
  });

  function renderSidebar(cards: BoardCard[], handlers: { onOpenCard?: () => void; onOpenReview?: () => void } = {}) {
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "sam", role: "owner" } });
      if (url === "/projects/p1/cards") return Promise.resolve({ cards });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const onOpenCard = handlers.onOpenCard ?? vi.fn();
    const onOpenReview = handlers.onOpenReview ?? vi.fn();
    renderApp(
      createElement(ProjectSidebar, {
        projects: [project],
        selectedProjectId: "p1",
        selectedCardId: null,
        mobileOpen: false,
        onCloseMobile: vi.fn(),
        onSelectProject: vi.fn(),
        onOpenCard,
        onOpenReview,
        onReorder: vi.fn(),
        onNewProject: vi.fn(),
        onNewCard: vi.fn(),
        onDeleteProject: vi.fn(),
      }),
    );
    return { onOpenCard, onOpenReview };
  }

  it("card com revisão mostra a linha do PR com o estado", async () => {
    renderSidebar([
      card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 }),
      card("c2", "pedidos", { id: "r2", prNumber: 553, phase: "ready", round: 1 }),
      card("c3", "estoque", { id: "r3", prNumber: 551, phase: "impasse", round: 3 }),
      card("c4", "antigo", { id: "r4", prNumber: 550, phase: "merged", round: 2 }),
      card("c5", "sem pr"),
    ]);

    const fixing = await screen.findByRole("link", { name: "PR #552 · rodada 2/3" });
    const ready = screen.getByRole("link", { name: "PR #553 · pronto pra merge" });
    const impasse = screen.getByRole("link", { name: "PR #551 · impasse" });

    // Cor pela fase: pronto verde, em andamento laranja, impasse azul.
    expect(ready).toHaveClass("text-emerald-400");
    expect(fixing).toHaveClass("text-amber-400");
    expect(impasse).toHaveClass("text-sky-400");

    // Mergeado é trabalho feito: o card fica, a linha do PR sai.
    expect(screen.getByRole("link", { name: "antigo" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^PR #550/ })).toBeNull();

    // Fica embaixo do próprio card, e só os cards com revisão em aberto ganham a linha.
    const title = screen.getByRole("link", { name: "realtime" });
    expect(title.compareDocumentPosition(fixing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.parentElement).toBe(fixing.parentElement);
    expect(screen.getAllByRole("link", { name: /^PR #/ })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "sem pr" }).parentElement?.querySelectorAll("a")).toHaveLength(1);
  });

  it("dúvida esperando o revisor humano: a linha diz aguardando decisão, em azul", async () => {
    renderSidebar([card("c1", "realtime", { id: "r1", prNumber: 552, phase: "reviewing", round: 1, pendingQuestions: 1 })]);
    const line = await screen.findByRole("link", { name: "PR #552 · aguardando decisão" });
    expect(line).toHaveClass("text-sky-400");
  });

  it("revisão cancelada não deixa linha (o servidor nem manda, e cache velho não ressuscita)", async () => {
    renderSidebar([card("c1", "realtime", { id: "r1", prNumber: 552, phase: "cancelled", round: 2 })]);
    await screen.findByRole("link", { name: "realtime" });
    expect(screen.queryByRole("link", { name: /^PR #/ })).toBeNull();
  });

  it("a linha é um link de verdade pro card com o painel (?review=1)", async () => {
    renderSidebar([card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 })]);
    const line = await screen.findByRole("link", { name: "PR #552 · rodada 2/3" });
    expect(line).toHaveAttribute("href", "?project=p1&card=c1&review=1");
    // O link do card segue o mesmo de antes, sem a marca.
    expect(screen.getByRole("link", { name: "realtime" })).toHaveAttribute("href", "?project=p1&card=c1");
  });

  it("clicar na linha do PR abre o card com o painel", async () => {
    const { onOpenCard, onOpenReview } = renderSidebar([
      card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 }),
    ]);
    const line = await screen.findByRole("link", { name: "PR #552 · rodada 2/3" });

    // fireEvent devolve false quando o handler cancelou a navegação do navegador.
    expect(fireEvent.click(line)).toBe(false);

    expect(onOpenReview).toHaveBeenCalledWith("p1", "c1");
    // Não é o clique do card: aquele alterna (abre/fecha), este só abre.
    expect(onOpenCard).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl/Shift-click na linha deixa o navegador abrir outra aba", async () => {
    const { onOpenReview } = renderSidebar([
      card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 }),
    ]);
    const line = await screen.findByRole("link", { name: "PR #552 · rodada 2/3" });

    expect(fireEvent.click(line, { metaKey: true })).toBe(true);
    expect(fireEvent.click(line, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(line, { shiftKey: true })).toBe(true);
    expect(onOpenReview).not.toHaveBeenCalled();
  });

  it("clicar no card continua abrindo o card, sem painel", async () => {
    const { onOpenCard, onOpenReview } = renderSidebar([
      card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 }),
    ]);

    fireEvent.click(await screen.findByRole("link", { name: "realtime" }));

    expect(onOpenCard).toHaveBeenCalledWith("p1", "c1");
    expect(onOpenReview).not.toHaveBeenCalled();
  });

  it("o botão direito na linha abre o menu do card, o mesmo do título", async () => {
    renderSidebar([card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 })]);
    const line = await screen.findByRole("link", { name: "PR #552 · rodada 2/3" });

    fireEvent.contextMenu(line);

    const menu = await screen.findByRole("menu", { name: "Ações de realtime" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Renomear/ })).toBeInTheDocument();
  });

  it("o card aberto fica realçado com a linha dele junto (uma só marca)", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/setup/state") return Promise.resolve(setupState());
      if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "sam", role: "owner" } });
      return Promise.resolve({ cards: [card("c1", "realtime", { id: "r1", prNumber: 552, phase: "fixing", round: 2 })] });
    });
    renderApp(
      createElement(ProjectSidebar, {
        projects: [project], selectedProjectId: "p1", selectedCardId: "c1", mobileOpen: false,
        onCloseMobile: vi.fn(), onSelectProject: vi.fn(), onOpenCard: vi.fn(), onReorder: vi.fn(),
        onNewProject: vi.fn(), onNewCard: vi.fn(), onDeleteProject: vi.fn(),
      }),
    );
    const title = await screen.findByRole("link", { name: "realtime" });
    expect(title).toHaveAttribute("aria-current", "true");
    // O realce é da linha inteira (card + PR), não de uma metade só.
    const row = title.parentElement as HTMLElement;
    expect(row.className).toMatch(/bg-primary/);
    expect(row).toContainElement(screen.getByRole("link", { name: "PR #552 · rodada 2/3" }));
  });
});

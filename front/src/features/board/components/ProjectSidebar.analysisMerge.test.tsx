import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { ProjectSidebar } from "@/features/board/components/ProjectSidebar";
import type { BoardCard, BoardProject } from "@/features/board/api";
import { renderApp, setupState } from "@/test/render";
import { get } from "@/lib/api";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);

const project: BoardProject = { id: "p1", name: "erp-aux", baseBranch: "prod", position: 0, createdAt: 1 };

const analysisCard = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: "c1", projectId: "p1", title: "Análise PR #649", column: "waiting", openedAt: 1, tmuxSession: "vh-c1", worktreeSlug: "analise-649", createdAt: 1, ...over,
});

function renderSidebarWith(card: BoardCard) {
  mockGet.mockImplementation((url: string) => {
    if (url === "/setup/state") return Promise.resolve(setupState());
    if (url === "/auth/me") return Promise.resolve({ user: { id: "u1", username: "mussa", role: "owner" } });
    if (url === "/projects/p1/cards") return Promise.resolve({ cards: [card] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  renderApp(
    <ProjectSidebar
      projects={[project]}
      selectedProjectId="p1"
      selectedCardId={null}
      mobileOpen={false}
      onCloseMobile={vi.fn()}
      onSelectProject={vi.fn()}
      onOpenCard={vi.fn()}
      onReorder={vi.fn()}
      onNewProject={vi.fn()}
      onNewCard={vi.fn()}
      onDeleteProject={vi.fn()}
    />,
  );
}

describe("ProjectSidebar — merge da análise rodando no card", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    setLanguage("pt-BR");
  });
  afterEach(() => {
    localStorage.removeItem(LANGUAGE_KEY);
    setLanguage("en");
  });

  it("card com analysisMerging mostra a linha verde de merge rodando, fora do painel", async () => {
    renderSidebarWith(analysisCard({ analysisMerging: true }));
    expect(await screen.findByText("Análise PR #649")).toBeInTheDocument();
    expect(screen.getByText("mergeando o PR…")).toBeInTheDocument();
  });

  it("card sem merge rodando não mostra a linha", async () => {
    renderSidebarWith(analysisCard());
    expect(await screen.findByText("Análise PR #649")).toBeInTheDocument();
    expect(screen.queryByText("mergeando o PR…")).not.toBeInTheDocument();
  });

  it("card com ordem de merge guardada esperando o CI diz que o merge está na fila e para qual branch", async () => {
    renderSidebarWith(analysisCard({
      mergeOrder: { sha: "b3ca4b2", target: "main", prUrl: "https://github.com/o/r/pull/411", orderedAt: 1 },
    }));
    expect(await screen.findByText("Análise PR #649")).toBeInTheDocument();
    expect(screen.getByText("merge em main na fila: sai quando o CI do PR ficar verde")).toBeInTheDocument();
  });

  it("card sem ordem de merge guardada não mostra a linha da fila", async () => {
    renderSidebarWith(analysisCard());
    expect(await screen.findByText("Análise PR #649")).toBeInTheDocument();
    expect(screen.queryByText(/na fila: sai quando o CI/)).not.toBeInTheDocument();
  });
});

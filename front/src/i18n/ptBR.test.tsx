import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { CardTile } from "@/features/board/components/CardTile";
import { CardTerminalView } from "@/features/board/components/CardTerminalView";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { applyOutcomeMessage } from "@/features/board/lib/applyOutcome";
import { columnHint, columnLabel, statusDot } from "@/features/board/lib/board";
import { LANGUAGE_KEY, setLanguage, t } from "@/i18n";
import type { BoardCard, BoardProject } from "@/features/board/api";
import type { CardColumn } from "@/api/types";

/**
 * The other half of the suite.
 *
 * Everything else asserts English, because jsdom reports `en-US` and English is the default. This
 * file switches the language the way the Settings select does and checks that the screens actually
 * follow — across a board tile, the card bar, the settings dialog and the toast copy, so a key that
 * was added to `en.ts` and forgotten in `pt-BR.ts` fails here rather than in front of the operator.
 */

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  patch: (...a: unknown[]) => patch(...a),
  del: (...a: unknown[]) => del(...a),
}));

// The terminal is a real xterm; it does not open under jsdom and is not what this file is about.
vi.mock("@/features/board/components/XTerminal", () => ({
  XTerminal: () => <div data-testid="xterm" />,
}));

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    projectId: "p1",
    title: "corrigir os totais",
    column: "working",
    position: 0,
    tmuxSession: "card-c1",
    worktreeSlug: "corrigir-os-totais-c1",
    createdAt: 1,
    ...overrides,
  };
}

const project: BoardProject = {
  id: "p1",
  name: "erp-aux",
  createdAt: 1,
} as BoardProject;

afterEach(() => {
  setLanguage("en");
  localStorage.removeItem(LANGUAGE_KEY);
  vi.clearAllMocks();
});

describe("pt-BR — the board", () => {
  it("names the five columns the way the operator asked for them", () => {
    setLanguage("pt-BR");
    const order: CardColumn[] = ["backlog", "paused", "waiting", "working", "done"];
    expect(order.map(columnLabel)).toEqual([
      "Backlog",
      "Pausados",
      "Aguardando",
      "Trabalhando",
      "Feito",
    ]);
    expect(columnHint("done")).toBe("Concluído. Sempre um movimento manual.");
  });

  it("translates the two statuses a dot can carry", () => {
    setLanguage("pt-BR");
    expect(statusDot("working")?.label).toBe("Trabalhando");
    expect(statusDot("waiting")?.label).toBe("Aguardando você");
  });

  it("translates a card tile, chips and menu included", async () => {
    setLanguage("pt-BR");
    renderApp(
      <CardTile
        card={card({ column: "paused", openedAt: 5 })}
        projectLabel="erp-aux"
        onOpen={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Pausando quando ficar livre…")).toBeInTheDocument();
    const tile = screen.getByRole("link", { name: "corrigir os totais" });
    expect(within(tile).getByTitle("Projeto: erp-aux")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Ações de corrigir os totais" }),
    ).toBeInTheDocument();
  });
});

describe("pt-BR — the card bar", () => {
  it("translates the actions, the panes and the pills", async () => {
    setLanguage("pt-BR");
    get.mockImplementation(async (url: string) => {
      if (url === "/accounts") return { accounts: [], defaultLabel: "" };
      if (url.endsWith("/session")) return { model: null, modelLabel: null, account: null };
      return {};
    });
    post.mockResolvedValue({ card: card({ openedAt: 5 }) });

    renderApp(
      <CardTerminalView project={project} cardId="c1" onBack={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /Pausar/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Reiniciar/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Concluir/ })).toBeInTheDocument();
    // "Browser" becomes "Navegador"; "Shell" is the command you actually type, so it stays.
    expect(screen.getByRole("button", { name: "Navegador" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shell" })).toBeInTheDocument();
    expect(screen.getByLabelText("Modelo")).toBeInTheDocument();
    expect(screen.getByLabelText("Conta Claude")).toBeInTheDocument();
  });

  it("leaves the composer's placeholder empty and puts the instructions in its label", async () => {
    setLanguage("pt-BR");
    get.mockResolvedValue({});
    post.mockResolvedValue({ card: card({ openedAt: 5 }) });

    renderApp(<CardTerminalView project={project} cardId="c1" onBack={vi.fn()} />);

    const box = await screen.findByLabelText("Escreva aqui — Enter envia, Shift+Enter quebra linha");
    expect(box).toHaveAttribute("placeholder", "");
  });
});

describe("pt-BR — settings", () => {
  it("translates the dialog and offers the language select", async () => {
    setLanguage("pt-BR");
    get.mockImplementation(async (url: string) => {
      if (url === "/settings") {
        return {
          git: { name: "Ada", email: "ada@example.com" },
          autonomous: true,
          defaultAccountLabel: null,
          transcribeLanguage: "pt",
        };
      }
      if (url === "/github") return { connections: [] };
      if (url === "/transcribe") return { available: false, proofread: false, language: "pt" };
      if (url === "/credentials") return { credentials: [] };
      throw new Error(`unexpected ${url}`);
    });

    renderApp(<SettingsDialog open onOpenChange={() => {}} />);

    expect(await screen.findByText("Configurações")).toBeInTheDocument();
    const select = screen.getByLabelText("Idioma da interface") as HTMLSelectElement;
    expect(select.value).toBe("pt-BR");
    expect(within(select).getByText("Português (Brasil)")).toBeInTheDocument();
    expect(within(select).getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Identidade do Git")).toBeInTheDocument();
    expect(screen.getByLabelText("Rodar sem pedir permissão")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Nome")).toHaveValue("Ada"));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
  });
});

describe("pt-BR — the sentences that only ever appear in a toast", () => {
  it("translates the card toasts, interpolation included", () => {
    setLanguage("pt-BR");
    expect(t("toast.cardPaused")).toBe("Pausado — reabrir o card retoma a mesma conversa.");
    expect(t("toast.cardFinished", { title: "corrigir os totais" })).toBe(
      "“corrigir os totais” concluído — parei de acompanhar o terminal.",
    );
    expect(t("confirm.restartWorking")).toBe(
      "O Claude está trabalhando — reiniciar vai interromper. Continuar?",
    );
  });

  it("keeps the apply report's counts and verb agreement", () => {
    setLanguage("pt-BR");
    expect(applyOutcomeMessage({ applied: true, restarted: 3, pending: 2 }, t("brain.subject"))).toBe(
      "Cérebro — salvo, aplicado a 3 terminais, 2 atualizam quando terminarem.",
    );
    expect(applyOutcomeMessage({ applied: true, restarted: 1, pending: 1 }, t("brain.subject"))).toBe(
      "Cérebro — salvo, aplicado a 1 terminal, 1 atualiza quando terminar.",
    );
    expect(applyOutcomeMessage({ applied: true, restarted: 4, pending: 0 }, t("brain.subject"))).toBe(
      "Cérebro — salvo, aplicado a 4 terminais.",
    );
  });
});

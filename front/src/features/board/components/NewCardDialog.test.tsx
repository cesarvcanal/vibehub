import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewCardDialog } from "@/features/board/components/NewCardDialog";
import { renderApp } from "@/test/render";
import { get } from "@/lib/api";

const LISTA_PADRAO = { branches: ["main", "dev", "feat/pdv", "prod", "fix/caixa"], defaultBranch: "main", truncada: false };
const respostasBranches = vi.hoisted(() => ({ proxima: [] as (() => Promise<unknown>)[] }));

// The shell's auth probe would otherwise reach for a real XHR under jsdom.
vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn().mockImplementation((url: string) =>
    url === "/github/repos/acme/p1/branches"
      ? (respostasBranches.proxima.shift()?.() ?? Promise.resolve(LISTA_PADRAO))
      : url === "/accounts/usage"
      ? Promise.resolve({
          bySlug: {
            default: { available: true, fiveHour: { utilization: 8, resetsAt: null }, fetchedAt: 1 },
            personal: { available: true, fiveHour: { utilization: 91.4, resetsAt: null }, fetchedAt: 1 },
          },
          fetchedAt: 1,
        })
      : Promise.resolve({}),
  ),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

async function escolherBase(user: ReturnType<typeof userEvent.setup>, nome: string) {
  await user.click(await screen.findByLabelText("Cut from"));
  const opcao = screen
    .getAllByRole("option")
    .find((o) => o.querySelector(".font-mono")?.textContent === nome || o.textContent === nome);
  if (!opcao) throw new Error(`branch ${nome} não está na lista`);
  await user.click(opcao);
}

function nomesDasOpcoes() {
  return within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.querySelector(".font-mono")?.textContent ?? o.textContent);
}

afterEach(() => {
  respostasBranches.proxima = [];
});

function opcaoDaBranch(nome: string) {
  const opcao = screen.getAllByRole("option").find((o) => o.querySelector(".font-mono")?.textContent === nome);
  if (!opcao) throw new Error(`branch ${nome} não está na lista`);
  return opcao;
}

function setup(overrides: Partial<React.ComponentProps<typeof NewCardDialog>> = {}) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  renderApp(
    <NewCardDialog
      open
      onOpenChange={onOpenChange}
      projects={[{ id: "p1", name: "P1", repoFullName: "acme/p1", baseBranch: "dev", position: 0, createdAt: 1 }]}
      initialProjectId="p1"
      accounts={[{ slug: "personal", name: "Personal" }]}
      defaultAccountLabel="the runner default"
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { user, onSubmit, onOpenChange };
}

describe("NewCardDialog", () => {
  // With the options open the form is taller than a laptop screen: the dialog stops at 90% of the
  // viewport and scrolls inside, so "Criar card" is never pushed off the bottom.
  it("never grows past 90% of the viewport height, scrolling inside instead", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("max-h-[90vh]");
    expect(dialog).toHaveClass("overflow-y-auto");
  });

  it("closes on submit instead of waiting for the server", async () => {
    // Creating a card can mean cloning a repository. Blocking on that turned "spin up four cards"
    // into four separate waits.
    const { user, onSubmit, onOpenChange } = setup();

    await user.type(screen.getByLabelText("Title"), "fix the totals");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "fix the totals" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with a fixed project shows no project picker", () => {
    setup();
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("from a no-project context asks which project, and submits with the one chosen", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderApp(
      <NewCardDialog
        open
        onOpenChange={vi.fn()}
        projects={[
          { id: "p1", name: "billing", repoFullName: "acme/billing", baseBranch: "dev", position: 0, createdAt: 1 },
          { id: "p2", name: "gateway", repoFullName: "acme/gateway", baseBranch: "main", position: 1, createdAt: 2 },
        ]}
        initialProjectId={null}
        accounts={[]}
        defaultAccountLabel="the runner default"
        onSubmit={onSubmit}
      />,
    );
    const picker = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    await user.selectOptions(picker, "p2");
    await user.type(screen.getByLabelText("Title"), "rotate the key");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p2", title: "rotate the key" });
  });

  it("closes on Enter too, so a card is a type-and-go", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.type(screen.getByLabelText("Title"), "chase the flake{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears the form on submit, so reopening does not show the last card's title", async () => {
    const { user } = setup();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.type(title, "first{Enter}");
    expect(title.value).toBe("");
  });

  it("clears the form on Cancel too, so an abandoned draft does not come back", async () => {
    const { user, onOpenChange } = setup();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    await user.type(title, "thought better of it");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Cancel used to call onOpenChange directly and skip the reset in the Dialog's own handler.
    expect(title.value).toBe("");
  });

  it("clears the options too, so a branch typed and abandoned cannot ride along next time", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.type(screen.getByLabelText("Branch"), "feat/oops");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // The disclosure closes with them: reopening starts from "whatever the project uses".
    expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Options" }));
    expect((screen.getByLabelText("Branch") as HTMLInputElement).value).toBe("");
  });

  it("keeps the options folded away until they are asked for", () => {
    setup();
    // The answer is almost always "whatever the project uses"; a card is meant to be type-and-go.
    expect(screen.queryByLabelText("Claude account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toHaveAttribute("aria-expanded", "false");
  });

  it("refuses an empty or whitespace-only title without closing", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    expect((screen.getByRole("button", { name: "Create card" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Title"), "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("trims the title before sending it", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "  padded  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: "padded" }));
  });

  it("says the untouched model is Opus — the server pins it — instead of an 'account default'", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "plain");
    await user.click(screen.getByRole("button", { name: "Options" }));
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]?.textContent).toBe("Default (Opus)");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "plain" });
  });

  it("keeps the richer options — account, model and branch still ride along", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "with options");
    await user.click(screen.getByRole("button", { name: "Options" }));

    await user.selectOptions(screen.getByLabelText("Claude account"), "personal");
    await user.selectOptions(screen.getByLabelText("Model"), "opus");
    await user.type(screen.getByLabelText("Branch"), "feat/totals");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "p1",
      title: "with options",
      accountSlug: "personal",
      model: "opus",
      branch: "feat/totals",
    });
  });

  it("puts each account's plan usage in the select, so the choice is informed", async () => {
    // The whole point: the owner burned an account's limit because picking one was a name in a list
    // with no number attached.
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));

    const select = screen.getByLabelText("Claude account") as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        "Inherit (the runner default) — 8%",
        "Personal — 91%",
      ]),
    );
  });

  it("locks the card to a base branch when asked: sends `base` and `locked`", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "ajuste do dev");
    await user.click(screen.getByRole("button", { name: "Options" }));

    await escolherBase(user, "dev");
    await user.click(screen.getByLabelText(/Lock the card to this branch/));
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "p1",
      title: "ajuste do dev",
      base: "dev",
      locked: true,
    });
  });

  it("the lock is OPT-IN: off by default, and nothing is sent when it is not ticked", async () => {
    // It did not exist before, and a card that does not ask for it must behave exactly as it always
    // did — no `locked` in the payload at all, not even `false`.
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "como sempre");
    await user.click(screen.getByRole("button", { name: "Options" }));

    const lock = screen.getByLabelText(/Lock the card to this branch/) as HTMLInputElement;
    expect(lock.checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "como sempre" });
  });

  it("clears the lock on Cancel, so it cannot ride along into the next card", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await escolherBase(user, "main");
    expect(screen.getByLabelText("Cut from")).toHaveTextContent("main");
    await user.click(screen.getByLabelText(/Lock the card to this branch/));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByLabelText("Cut from")).toHaveTextContent("The project's (dev)");
    expect((screen.getByLabelText(/Lock the card to this branch/) as HTMLInputElement).checked).toBe(false);
  });

  it("offers the repository's REAL branches as the base, instead of asking for a guess", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));

    await user.click(await screen.findByLabelText("Cut from"));
    expect(nomesDasOpcoes()).toEqual(["The project's (dev)", "main", "prod", "dev", "feat/pdv", "fix/caixa"]);
    expect(screen.getByText("Main branches")).toBeInTheDocument();
    expect(screen.getByText("Other branches (2)")).toBeInTheDocument();
    const prod = screen.getAllByRole("option").find((o) => o.querySelector(".font-mono")?.textContent === "prod");
    expect(prod).toHaveTextContent("production");
    const main = screen.getAllByRole("option").find((o) => o.querySelector(".font-mono")?.textContent === "main");
    expect(main).toHaveTextContent("default");
  });

  it("busca a branch pelo nome e escolhe com Enter", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "caixa");
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));

    await user.type(screen.getByRole("searchbox"), "CAIXA");
    expect(nomesDasOpcoes()).toEqual(["fix/caixa"]);
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Cut from")).toHaveTextContent("fix/caixa");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "caixa", base: "fix/caixa" });
  });

  it("busca sem resultado diz que não achou e Enter não escolhe nada", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.type(screen.getByRole("searchbox"), "nao-existe");

    expect(screen.getByText("No branch with that name.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Esc fecha só a lista, não o diálogo", async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("rolar o diálogo pela barra de rolagem não fecha a lista", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    // Clicar na barra de rolagem do diálogo põe o foco no próprio diálogo, ancestral do seletor.
    act(() => screen.getByRole("dialog").focus());

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("perder o foco para outro campo fecha a lista", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.click(screen.getByLabelText("Branch", { exact: true }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("navega pelas setas a partir da branch escolhida", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await escolherBase(user, "main");
    await user.click(screen.getByLabelText("Cut from"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByLabelText("Cut from")).toHaveTextContent("prod");
  });

  it("atualização que falha avisa no rodapé que a lista pode estar desatualizada", async () => {
    respostasBranches.proxima = [() => Promise.resolve(LISTA_PADRAO), () => Promise.reject(new Error("403"))];
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh the list from GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh the list from GitHub");
    expect(opcaoDaBranch("prod")).toBeInTheDocument();
  });

  it("lista cortada pelo back avisa quantas está mostrando", async () => {
    respostasBranches.proxima = [() => Promise.resolve({ ...LISTA_PADRAO, truncada: true })];
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    expect(screen.getByText("Showing the first 5 branches on GitHub")).toBeInTheDocument();
  });

  it("a linha ativa segue a mesma branch quando a lista muda com o seletor aberto", async () => {
    respostasBranches.proxima = [
      () => Promise.resolve(LISTA_PADRAO),
      () => Promise.resolve({ ...LISTA_PADRAO, branches: ["production", "staging", ...LISTA_PADRAO.branches] }),
    ];
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(opcaoDaBranch("prod")).toHaveAttribute("data-active");

    await user.click(screen.getByRole("button", { name: "Refresh the list from GitHub" }));
    await waitFor(() => expect(opcaoDaBranch("production")).toBeInTheDocument());
    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Cut from").querySelector(".font-mono")).toHaveTextContent(/^prod$/);
  });

  it("anuncia a opção ativa ao leitor de tela pelo aria-activedescendant", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("searchbox")).toHaveAttribute("aria-activedescendant", opcaoDaBranch("main").id);
  });

  it("Esc com o foco no botão de atualizar fecha só a lista", async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    screen.getByRole("button", { name: "Refresh the list from GitHub" }).focus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("fecha a lista quando o foco sai do seletor", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.click(screen.getByLabelText("Branch"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("abrir com a lista fresca não vai ao GitHub de novo; o botão de atualizar vai", async () => {
    const { user } = setup();
    const chamadasBranches = () =>
      vi.mocked(get).mock.calls.filter(([url]) => url === "/github/repos/acme/p1/branches").length;
    const antes = chamadasBranches();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByLabelText("Cut from"));
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Cut from"));
    expect(chamadasBranches() - antes).toBe(1);

    await user.click(screen.getByRole("button", { name: "Refresh the list from GitHub" }));
    await waitFor(() => expect(chamadasBranches() - antes).toBe(2));
  });

  it("refuses a branch name the server would refuse, and says why", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "nome ruim");
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.type(screen.getByLabelText("Branch"), "feat/../etc");

    expect(await screen.findByText(/Invalid name/)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Create card" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Create card" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a working branch equal to the base — the card would commit straight into it", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "direto na prod");
    await user.click(screen.getByRole("button", { name: "Options" }));
    await escolherBase(user, "main");
    await user.type(screen.getByLabelText("Branch"), "main");

    expect(await screen.findByText(/cannot be the same as the base/)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Create card" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("catches it against the INHERITED base too, not only against one picked by hand", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Title"), "direto na dev");
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.type(screen.getByLabelText("Branch"), "dev"); // base left on "the project's (dev)"

    expect(await screen.findByText(/cannot be the same as the base/)).toBeInTheDocument();
  });

  it("WARNS about an existing branch without blocking — opening one is a real thing to want", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "retomar o pdv");
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.type(screen.getByLabelText("Branch"), "feat/pdv");

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "Create card" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Create card" }));
    expect(onSubmit).toHaveBeenCalledWith({
      projectId: "p1",
      title: "retomar o pdv",
      branch: "feat/pdv",
    });
  });

  it("says nothing about a brand-new name — the quiet path stays quiet", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await screen.findByLabelText("Cut from"); // branches loaded
    await user.type(screen.getByLabelText("Branch"), "fix/nota-fiscal");

    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invalid name/)).not.toBeInTheDocument();
  });

  it("omits the optional fields entirely when they are left alone", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText("Title"), "bare{Enter}");
    // Not `accountSlug: ""` — an empty string would pin the card to a nameless account.
    expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "bare" });
  });

  describe("conta Claude de quem cria", () => {
    it("sem conta vinculada não avisa nada — funciona como antes", () => {
      setup();
      expect(screen.queryByTestId("new-card-no-own-account")).toBeNull();
    });

    it("com conta própria, 'herdar' mostra que é a conta da pessoa", async () => {
      const { user, onSubmit } = setup({ ownAccountSlug: "personal" });
      await user.click(screen.getByRole("button", { name: "Options" }));
      expect(screen.getByRole("option", { name: /^Your account \(Personal\)/ })).toBeInTheDocument();
      // Nada de conta no corpo: quem carimba a conta do criador é o servidor.
      await user.type(screen.getByLabelText("Title"), "x");
      await user.click(screen.getByRole("button", { name: "Create card" }));
      expect(onSubmit).toHaveBeenCalledWith({ projectId: "p1", title: "x" });
    });

    it("ligado à conta embutida do runner (o César), 'herdar' mostra ela como dele", async () => {
      const { user } = setup({ ownAccountSlug: "default" });
      await user.click(screen.getByRole("button", { name: "Options" }));
      expect(screen.getByRole("option", { name: /^Your account \(the runner default\)/ })).toBeInTheDocument();
    });

    it("ligado à padrão num projeto com conta própria, 'herdar' mostra a do projeto (é onde o card cai)", async () => {
      const { user } = setup({
        ownAccountSlug: "default",
        projects: [{
          id: "p1", name: "P1", repoFullName: "acme/p1", baseBranch: "dev", position: 0, createdAt: 1,
          defaultAccountSlug: "personal",
        }],
      });
      await user.click(screen.getByRole("button", { name: "Options" }));
      expect(screen.getByRole("option", { name: /^Inherit \(personal\)/ })).toBeInTheDocument();
    });

  });
});

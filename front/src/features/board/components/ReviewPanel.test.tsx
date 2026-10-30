import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { renderApp, setupState } from "@/test/render";
import { ReviewPanel } from "./ReviewPanel";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import type { Finding, Review } from "@/api/types";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  get: (...a: unknown[]) => get(...a),
  post: (...a: unknown[]) => post(...a),
  del: vi.fn(),
  patch: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

/** The people of the fixture: a user id per role, so each test signs in as the role it is about. */
const USERS = {
  rev: { id: "u-rev", username: "mussa", role: "member" },
  aut: { id: "u-aut", username: "albert", role: "member" },
  mer: { id: "u-mer", username: "kim", role: "member" },
  co: { id: "u-co", username: "bia", role: "member" },
  own: { id: "u-own", username: "cesar", role: "owner" },
} as const;
type Who = keyof typeof USERS;

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1", prNumber: 553, phase: "fixing", round: 2, cardId: "c1", projectId: "p1",
    prUrl: "https://github.com/acme/erp/pull/553", prBranch: "card/pedidos", base: "dev",
    reviewerUserId: "u-rev", authorUserId: "u-aut", mergerUserId: "u-mer", reviewerCardId: "rc1",
    findings: [], log: [], createdAt: 1, updatedAt: 2, ...overrides,
  };
}
function finding(overrides: Partial<Finding> = {}): Finding {
  return { id: "f1", severity: "blocking", title: "Aba volta e busca 2x", status: "open", introducedInRound: 1, ...overrides };
}

/** What the server will answer to `GET /cards/c1/review`; the test can change it between polls. */
let current: Review | null;
/** Who the server says is working right now (the cards' status). */
let working: { author: boolean; reviewer: boolean };
let me: Who;
let reviewGets = 0;

function serve() {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: USERS[me] };
    if (url === "/setup/state") return setupState();
    if (url === "/cards/c1/review") {
      reviewGets += 1;
      return current ? { review: current, working } : { review: null };
    }
    if (url === "/cards/c1/people") {
      return { people: Object.values(USERS).map((u) => ({ id: u.id, username: u.username, canReview: true })) };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function open(who: Who, r: Review | null, onClose = vi.fn()) {
  me = who;
  current = r;
  const view = renderApp(<ReviewPanel cardId="c1" onClose={onClose} />);
  return { ...view, onClose };
}

/** Moves the fake clock inside act(): the reads it triggers land as state updates. */
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The panel is up when the PR header is. */
const loaded = () => screen.findByText("PR #553");

function failure(status: number | undefined, data?: unknown) {
  return Object.assign(new Error("Request failed"), status === undefined ? {} : { response: { status, data } });
}

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("pt-BR");
  reviewGets = 0;
  working = { author: false, reviewer: false };
  me = "rev";
  current = null;
  serve();
  // An action answers with the review as it stands: tests that need it to change say so.
  post.mockImplementation(async () => ({ review: current }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  // Unmount BEFORE the language flips back: a mounted `useT()` would re-render outside act().
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLanguage("en");
  localStorage.removeItem(LANGUAGE_KEY);
});

describe("ReviewPanel — o que mostra", () => {
  it("cabeçalho com PR, base, pill da rodada e os papéis pelo nome", async () => {
    open("rev", review({ coauthorUserId: "u-co" }));
    await loaded();

    expect(screen.getByText(/→ dev/)).toBeInTheDocument();
    expect(screen.getByText("rodada 2/3")).toBeInTheDocument();
    const roles = screen.getByTestId("review-roles");
    expect(within(roles).getByText("Revisor").parentElement).toHaveTextContent("mussa");
    expect(within(roles).getByText("Responsável").parentElement).toHaveTextContent("albert");
    expect(within(roles).getByText("Co-autor").parentElement).toHaveTextContent("bia");
    expect(within(roles).getByText("Faz o merge").parentElement).toHaveTextContent("kim");
    // Cada papel traz o nome que o GitHub dá a ele, e passar o mouse explica o que faz.
    expect(within(roles).getByText("Responsável").parentElement).toHaveTextContent("assignee");
    expect(within(roles).getByText("Responsável").parentElement).toHaveAttribute("title", expect.stringMatching(/committer e o pusher/));
    expect(within(roles).getByText("Revisor").parentElement).toHaveTextContent("reviewer");
    expect(within(roles).getByText("Co-autor").parentElement).toHaveAttribute("title", expect.stringMatching(/Co-authored-by/));
  });

  it("dúvida esperando o revisor humano: a pill diz aguardando decisão e a etapa diz de quem é a vez", async () => {
    open("aut", review({
      phase: "reviewing", round: 1, lastSubmitRound: 1,
      findings: [finding({ id: "f1", severity: "question", title: "a sessão expira no checkout?" })],
    }));
    await loaded();
    expect(screen.getByText("aguardando decisão")).toBeInTheDocument();
    expect(screen.queryByText("rodada 1/3")).toBeNull();
    expect(screen.getByText("Dúvida esperando a decisão do revisor humano.")).toBeInTheDocument();
  });

  it("sem co-autor o papel não aparece", async () => {
    open("rev", review());
    await loaded();
    expect(within(screen.getByTestId("review-roles")).queryByText("Co-autor")).toBeNull();
  });

  it("a barra tem 3 segmentos, os da rodada e antes preenchidos", async () => {
    open("rev", review({ round: 2 }));
    await loaded();
    const steps = within(screen.getByTestId("review-steps")).getAllByTestId("review-step");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["done", "current", "todo"]);
  });

  it("o cabeçalho da lista conta pelos dados: 3 bloqueiam · 1 sugestão · 1 derrubado", async () => {
    open("rev", review({
      findings: [
        finding({ id: "a", status: "fixed" }),
        finding({ id: "b", status: "fixed" }),
        finding({ id: "c", status: "contested" }),
        finding({ id: "d", severity: "suggestion" }),
        finding({ id: "e", severity: "refuted", status: "dropped" }),
      ],
    }));
    await loaded();
    expect(screen.getByText(/3 bloqueiam · 1 sugestão · 1 derrubado/)).toBeInTheDocument();
  });

  it("os plurais do cabeçalho concordam (1 bloqueia, 2 dúvidas, 2 sugestões)", async () => {
    open("rev", review({
      phase: "reviewing",
      findings: [
        finding({ id: "a" }),
        finding({ id: "b", severity: "suggestion" }),
        finding({ id: "c", severity: "suggestion" }),
        finding({ id: "d", severity: "question", humanDecision: "drop", status: "dropped" }),
        finding({ id: "e", severity: "question", humanDecision: "drop", status: "dropped" }),
      ],
    }));
    await loaded();
    expect(screen.getByText(/1 bloqueia · 2 dúvidas · 2 sugestões/)).toBeInTheDocument();
  });

  it("cada achado mostra severidade, título, arquivo:linha, prova, status e commit curto", async () => {
    open("rev", review({
      findings: [
        finding({
          title: "Aba volta e busca 2x", file: "src/useInvalidacao.ts", line: 96, status: "fixed",
          proof: { kind: "failing_test", ref: "useInvalidacao.test.ts:96" }, commit: "16235d5abcdef0123456789",
        }),
        finding({ id: "f2", severity: "suggestion", title: "Título do teste", proof: { kind: "rule", ref: "simplicidade.md §5" } }),
        finding({ id: "f3", severity: "question", title: "Faz sentido?", proof: { kind: "scenario", ref: "venda sem estoque" } }),
      ],
    }));
    await loaded();

    const row = screen.getByText("Aba volta e busca 2x").closest("[data-testid=finding]") as HTMLElement;
    expect(within(row).getByText("BLOQUEIA")).toBeInTheDocument();
    expect(within(row).getByText("src/useInvalidacao.ts:96")).toBeInTheDocument();
    expect(within(row).getByText("teste falha")).toBeInTheDocument();
    expect(within(row).getByText("useInvalidacao.test.ts:96")).toBeInTheDocument();
    expect(within(row).getByText("corrigido")).toBeInTheDocument();
    expect(within(row).getByText("16235d5")).toBeInTheDocument();

    const second = screen.getByText("Título do teste").closest("[data-testid=finding]") as HTMLElement;
    expect(within(second).getByText("sugestão")).toBeInTheDocument();
    expect(within(second).getByText("regra")).toBeInTheDocument();
    expect(within(second).getByText("aberto")).toBeInTheDocument();
    const third = screen.getByText("Faz sentido?").closest("[data-testid=finding]") as HTMLElement;
    expect(within(third).getByText("dúvida")).toBeInTheDocument();
    expect(within(third).getByText("cenário")).toBeInTheDocument();
  });

  it("sugestão que o autor não vai aplicar aparece como tal, e o cabeçalho mostra o commit revisado e o atual quando o PR andou", async () => {
    open("aut", review({
      phase: "ready", reviewedSha: "a".repeat(40), prHeadSha: "b".repeat(40),
      findings: [finding({ id: "s1", severity: "suggestion", status: "wontfix", title: "trocar a lib", authorReply: "fora do escopo" })],
    }));
    await loaded();
    expect(within(screen.getByTestId("finding")).getByText("não vai aplicar")).toBeInTheDocument();
    const commits = screen.getByTestId("review-commits");
    expect(commits).toHaveTextContent("commit revisado aaaaaaa");
    expect(commits).toHaveTextContent("o PR andou depois da revisão e está em bbbbbbb");
  });

  it("PR no mesmo commit da revisão: só o commit revisado, sem aviso", async () => {
    open("aut", review({ phase: "ready", reviewedSha: "a".repeat(40), prHeadSha: "a".repeat(40) }));
    await loaded();
    expect(screen.getByTestId("review-commits")).not.toHaveTextContent("andou");
  });

  it("os cinco status têm o seu texto", async () => {
    const statuses: [Finding["status"], string][] = [
      ["open", "aberto"], ["fixed", "corrigido"], ["contested", "contestado"],
      ["accepted_risk", "risco aceito"], ["dropped", "descartado"],
    ];
    open("aut", review({
      findings: statuses.map(([status], i) => finding({ id: `s${i}`, title: `item ${status}`, status, severity: "suggestion" })),
    }));
    await loaded();
    for (const [status, label] of statuses) {
      const row = screen.getByText(`item ${status}`).closest("[data-testid=finding]") as HTMLElement;
      expect(within(row).getByText(label)).toBeInTheDocument();
    }
  });

  it("achado derrubado aparece riscado", async () => {
    open("rev", review({
      findings: [
        finding({ id: "a", title: "Bloqueio real" }),
        finding({ id: "e", severity: "refuted", status: "dropped", title: "Link abrir entrada" }),
      ],
    }));
    await loaded();

    const row = screen.getByText("Link abrir entrada").closest("[data-testid=finding]") as HTMLElement;
    expect(within(row).getByText("derrubado")).toBeInTheDocument();
    expect(screen.getByText("Link abrir entrada")).toHaveClass("line-through");
    // Só o derrubado é riscado.
    expect(screen.getByText("Bloqueio real")).not.toHaveClass("line-through");
  });

  it("as respostas ficam recolhidas sob a linha e abrem ao clicar", async () => {
    open("aut", review({
      findings: [finding({ authorReply: "Contesto: já está no padrão.", reviewerReply: "Conferindo contra o guia." })],
    }));
    await loaded();
    await userEvent.click(screen.getByRole("tab", { name: /Achados/ }));
    expect(screen.queryByText("Contesto: já está no padrão.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /respostas/ }));

    expect(screen.getByText("Contesto: já está no padrão.")).toBeInTheDocument();
    expect(screen.getByText("Conferindo contra o guia.")).toBeInTheDocument();
  });

  it("achado sem resposta não oferece o recolhido", async () => {
    open("aut", review({ findings: [finding()] }));
    await loaded();
    expect(screen.queryByRole("button", { name: /respostas/ })).toBeNull();
  });

  it("abre na conversa; a aba Achados mostra a lista agrupada e as duas ficam montadas", async () => {
    open("aut", review({
      findings: [finding({ id: "f1", title: "Bloqueio A" }), finding({ id: "f2", severity: "suggestion", title: "Sugestão B" })],
      log: [{ at: 1, round: 1, who: "reviewer", text: "achei duas coisas" }],
    }));
    await loaded();
    expect(screen.getByRole("tab", { name: /Conversa/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("log")).toHaveTextContent("achei duas coisas");

    await userEvent.click(screen.getByRole("tab", { name: /Achados/ }));
    expect(screen.getByRole("tab", { name: /Achados/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByTestId("finding-group").map((g) => g.getAttribute("data-severity"))).toEqual(["blocking", "suggestion"]);
    // A conversa continua montada (escondida): voltar a ela não perde a rolagem.
    expect(screen.getByTestId("review-conversation")).toBeInTheDocument();
  });

  it("abre nos Achados quando quem olha tem uma decisão a tomar lá, e respeita a aba escolhida", async () => {
    open("rev", review({ phase: "reviewing", lastSubmitRound: 2, findings: [finding({ id: "q1", severity: "question", title: "dúvida" })] }));
    await loaded();
    await waitFor(() => expect(screen.getByRole("tab", { name: /Achados/ })).toHaveAttribute("aria-selected", "true"));
    await userEvent.click(screen.getByRole("tab", { name: /Conversa/ }));
    expect(screen.getByRole("tab", { name: /Conversa/ })).toHaveAttribute("aria-selected", "true");
  });

  it("Abrir no GitHub leva ao PR e fechar chama onClose", async () => {
    const { onClose } = open("aut", review());
    await loaded();
    expect(screen.getByRole("link", { name: "Abrir no GitHub" })).toHaveAttribute("href", "https://github.com/acme/erp/pull/553");

    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("abre a sessão do revisor (o card escondido) e o diff do PR numa aba nova", async () => {
    open("rev", review({ projectId: "p1", reviewerCardId: "rc1" }));
    await loaded();
    // O card do revisor não está no board: este link é o único caminho até o terminal dele.
    const session = screen.getByRole("link", { name: "Abrir sessão do revisor" });
    expect(session).toHaveAttribute("href", "/?project=p1&card=rc1");
    const diff = screen.getByRole("link", { name: "Ver diff" });
    expect(diff).toHaveAttribute("href", "https://github.com/acme/erp/pull/553/files");
    expect(diff).toHaveAttribute("target", "_blank");
    expect(diff).toHaveAttribute("rel", "noreferrer");
  });

  it("revisão encerrada não leva mais à sessão do revisor (o card dele vai pra done e some); o diff fica", async () => {
    for (const phase of ["merged", "cancelled"] as const) {
      open("rev", review({ phase }));
      await loaded();
      expect(screen.queryByRole("link", { name: "Abrir sessão do revisor" })).toBeNull();
      expect(screen.getByRole("link", { name: "Ver diff" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("sem revisão no card diz isso, sem botão nenhum de ação", async () => {
    open("rev", null);
    expect(await screen.findByText("Este card ainda não tem revisão de PR.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar revisão" })).toBeNull();
  });

  it("revisão que não carrega mostra o erro", async () => {
    me = "rev";
    get.mockImplementation(async (url: string) => {
      if (url === "/auth/me") return { user: USERS.rev };
      if (url === "/setup/state") return setupState();
      throw new Error("down");
    });
    renderApp(<ReviewPanel cardId="c1" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não deu pra carregar a revisão");
  });

  it("revisão cancelada ou mergeada mostra o estado e nenhuma ação", async () => {
    open("mer", review({ phase: "cancelled" }));
    await loaded();
    expect(screen.getByText("Revisão cancelada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mergear|Cancelar revisão|Tentar de novo/ })).toBeNull();
    cleanup();

    open("mer", review({ phase: "merged" }));
    await loaded();
    expect(screen.getByText("Mergeado na dev")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mergear na|Cancelar revisão|Tentar de novo/ })).toBeNull();
  });
});

describe("ReviewPanel — merge", () => {
  it("merge só aparece pro responsável e só em ready", async () => {
    open("mer", review({ phase: "ready" }));
    await loaded();
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeInTheDocument();
    cleanup();

    // Em qualquer outra fase, nem o responsável vê.
    for (const phase of ["reviewing", "fixing", "impasse", "merged"] as const) {
      open("mer", review({ phase }));
      await loaded();
      expect(screen.queryByRole("button", { name: /Mergear na/ })).toBeNull();
      cleanup();
    }

    // Em ready, quem não é o responsável não vê: revisor, autor, co-autor e nem o owner.
    for (const who of ["rev", "aut", "co", "own"] as const) {
      open(who, review({ phase: "ready", coauthorUserId: "u-co" }));
      await loaded();
      expect(screen.queryByRole("button", { name: /Mergear na/ })).toBeNull();
      cleanup();
    }
  });

  it("o botão leva a base na etiqueta e manda o POST do merge", async () => {
    open("mer", review({ phase: "ready", base: "prod" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Mergear na prod" }));

    expect(post).toHaveBeenCalledWith("/reviews/r1/merge");
  });

  it("merge pendente mostra Mergeando e trata head_moved", async () => {
    let refuse: (e: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((_, reject) => { refuse = reject; }));
    open("mer", review({ phase: "ready" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    // Pendente: o botão muda de texto e não aceita outro clique.
    const pending = await screen.findByRole("button", { name: "Mergeando…" });
    expect(pending).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Mergear na dev" })).toBeNull();

    // O servidor devolveu a revisão pra conferir o que mudou (rodada 3 de 3 -> aqui, reviewing).
    refuse(failure(409, {
      error: "o PR andou depois do pronto", reason: "head_moved", review: review({ phase: "reviewing", round: 2 }),
    }));

    expect(await screen.findByText("Houve push depois da revisão — a revisão voltou pra conferir o que mudou.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mergeando…" })).toBeNull();
    // A revisão voltou: já não há merge a fazer.
    expect(screen.queryByRole("button", { name: /Mergear na/ })).toBeNull();
    expect(screen.getByText("rodada 2/3")).toBeInTheDocument();
  });

  it("enquanto o merge está pendente o painel continua lendo a revisão", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockImplementation(() => new Promise(() => {}));
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));
    await screen.findByRole("button", { name: "Mergeando…" });

    const before = reviewGets;
    await tick(3_100);
    await tick(3_100);

    expect(reviewGets).toBeGreaterThanOrEqual(before + 2);
  });

  it("a conexão cai no merge mas a fase vira merged: mostra sucesso, não erro", async () => {
    post.mockRejectedValue(failure(undefined));
    open("mer", review({ phase: "ready" }));
    await loaded();

    // O merge saiu no servidor enquanto o pedido se perdia no meio do caminho.
    current = review({ phase: "merged" });
    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    expect(await screen.findByText("Mergeado na dev")).toBeInTheDocument();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("PR #553 mergeado na dev"));
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mergear na|Mergeando/ })).toBeNull();
  });

  it("timeout do proxy (504) com a fase ainda em ready avisa que está conferindo e segue lendo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(failure(504, "Gateway Time-out"));
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));

    expect(await screen.findByText(/A conexão caiu antes da resposta do merge/)).toBeInTheDocument();
    const before = reviewGets;
    // O merge terminou depois: a próxima leitura traz merged e o aviso dá lugar ao sucesso.
    current = review({ phase: "merged" });
    await tick(3_100);

    expect(await screen.findByText("Mergeado na dev")).toBeInTheDocument();
    expect(reviewGets).toBeGreaterThan(before);
    expect(screen.queryByText(/A conexão caiu antes da resposta do merge/)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("409 merging continua conferindo e mostra sucesso quando o merge termina", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(failure(409, { error: "merge já em andamento", reason: "merging" }));
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));

    // Um merge já corre no servidor: nem erro, nem botão livre. Fica conferindo.
    expect(await screen.findByText(/O merge já está em andamento/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergeando…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();

    // Segue lendo: a fase ainda é ready, e o merge termina no servidor.
    const before = reviewGets;
    await tick(3_100);
    expect(reviewGets).toBeGreaterThan(before);
    current = review({ phase: "merged" });
    await tick(3_100);

    expect(await screen.findByText("Mergeado na dev")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("PR #553 mergeado na dev");
    expect(screen.queryByText(/O merge já está em andamento/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Mergear na|Mergeando/ })).toBeNull();
  });

  it.each([
    ["conexão perdida (504)", () => failure(504, "Gateway Time-out")],
    ["409 merging", () => failure(409, { error: "merge já em andamento", reason: "merging" })],
  ])("espera sem confirmação (%s): o botão fica desabilitado até a fase mudar", async (_name, error) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(error());
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));

    const waiting = await screen.findByRole("button", { name: "Mergeando…" });
    expect(waiting).toBeDisabled();
    await tick(3_100);
    expect(screen.getByRole("button", { name: "Mergeando…" })).toBeDisabled();
  });

  it.each([
    ["conexão perdida (504)", () => failure(504, "Gateway Time-out")],
    ["409 merging", () => failure(409, { error: "merge já em andamento", reason: "merging" })],
  ])("depois de 16 min sem merged (%s) a espera acaba: botão volta e o painel manda conferir no GitHub", async (_name, error) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(error());
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));
    await screen.findByRole("button", { name: "Mergeando…" });

    // Antes do limite continua esperando.
    await tick(15 * 60_000);
    expect(screen.getByRole("button", { name: "Mergeando…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();

    await tick(2 * 60_000);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não deu pra confirmar o merge — confira no GitHub");
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeEnabled();
    // Sem sucesso falso se um merged aparecer depois (ninguém está mais conferindo).
    current = review({ phase: "merged" });
    await tick(10_100);
    expect(await screen.findByText("Mergeado na dev")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("cancelar e tentar de novo ficam desabilitados com o merge pendente e sem confirmação", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Responsável pelo merge: vê Mergear, Tentar de novo (Approve pendente) e Cancelar.
    let lose: (e: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((_, reject) => { lose = reject; }));
    open("mer", review({ phase: "ready", approvePending: true }));
    await loaded();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancelar revisão" })).toBeEnabled();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));

    // Pendente.
    await screen.findByRole("button", { name: "Mergeando…" });
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar revisão" })).toBeDisabled();

    // Resposta perdida: continua sem confirmação, ainda desabilitados.
    await act(async () => { lose(failure(undefined)); });
    await screen.findByText(/A conexão caiu antes da resposta do merge/);
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar revisão" })).toBeDisabled();
  });

  it("o aviso de head_moved some quando a fase ou a rodada mudam, e fica enquanto nada muda", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(failure(409, {
      error: "o PR andou", reason: "head_moved", review: review({ phase: "reviewing", round: 2 }),
    }));
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));
    const notice = "Houve push depois da revisão — a revisão voltou pra conferir o que mudou.";
    expect(await screen.findByText(notice)).toBeInTheDocument();

    // Nada mudou na leitura seguinte (reviewing, rodada 2): o aviso fica.
    current = review({ phase: "reviewing", round: 2 });
    await tick(3_100);
    expect(screen.getByText(notice)).toBeInTheDocument();

    // A fase muda (o autor corrige): o aviso sai.
    current = review({ phase: "fixing", round: 2 });
    await tick(3_100);
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  it("o aviso de head_moved também sai quando só a rodada muda", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    post.mockRejectedValue(failure(409, {
      error: "o PR andou", reason: "head_moved", review: review({ phase: "reviewing", round: 2 }),
    }));
    open("mer", review({ phase: "ready" }));
    await loaded();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Mergear na dev" }));
    const notice = "Houve push depois da revisão — a revisão voltou pra conferir o que mudou.";
    await screen.findByText(notice);

    current = review({ phase: "reviewing", round: 3 });
    await tick(3_100);

    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  it("a recusa do merge some quando a fase da revisão muda", async () => {
    post.mockRejectedValueOnce(failure(409, { error: "gate vermelho: 2 testes falharam", reason: "gate" }));
    open("mer", review({ phase: "ready" }));
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("gate vermelho");

    // Nada mudou ainda: continua. Depois o responsável cancela e a fase muda.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    post.mockResolvedValueOnce({ review: review({ phase: "cancelled" }) });
    await userEvent.click(screen.getByRole("button", { name: "Cancelar revisão" }));

    expect(await screen.findByText("Revisão cancelada")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recusa do servidor aparece como erro e o botão volta", async () => {
    post.mockRejectedValue(failure(400, { error: "merger_sem_github: sem conexão", reason: "merger_sem_github" }));
    open("mer", review({ phase: "ready" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem uma conexão GitHub própria no vibehub");
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeEnabled();
  });

  it("gate vermelho mostra a mensagem do servidor como veio", async () => {
    post.mockRejectedValue(failure(409, { error: "gate vermelho: 2 testes falharam", reason: "gate" }));
    open("mer", review({ phase: "ready" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("gate vermelho: 2 testes falharam");
  });

  it("o erro some no próximo clique", async () => {
    post.mockRejectedValueOnce(failure(409, { error: "gate vermelho", reason: "gate" }));
    post.mockImplementationOnce(() => new Promise(() => {}));
    open("mer", review({ phase: "ready" }));
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    await screen.findByRole("button", { name: "Mergeando…" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("merge feito pelo clique atualiza a tela pro mergeado", async () => {
    post.mockResolvedValue({ review: review({ phase: "merged" }) });
    open("mer", review({ phase: "ready" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Mergear na dev" }));

    expect(await screen.findByText("Mergeado na dev")).toBeInTheDocument();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });
});

describe("ReviewPanel — dúvidas e impasse", () => {
  const doubt = (overrides: Partial<Finding> = {}) =>
    finding({ id: "q1", severity: "question", title: "O cálculo está certo?", ...overrides });

  it("dúvida pendente mostra os botões só pro revisor", async () => {
    open("rev", review({ phase: "reviewing", findings: [doubt()] }));
    await loaded();
    expect(screen.getByRole("button", { name: "Bloquear" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
    cleanup();

    // O owner também decide.
    open("own", review({ phase: "reviewing", findings: [doubt()] }));
    await loaded();
    expect(screen.getByRole("button", { name: "Bloquear" })).toBeInTheDocument();
    cleanup();

    // Autor, responsável pelo merge e co-autor veem a dúvida, sem os botões.
    for (const who of ["aut", "mer", "co"] as const) {
      open(who, review({ phase: "reviewing", findings: [doubt()] }));
      await loaded();
      expect(screen.getByText("O cálculo está certo?")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Bloquear" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
      cleanup();
    }
  });

  it("os botões da dúvida mandam a decisão daquele achado", async () => {
    open("rev", review({ phase: "reviewing", findings: [doubt({ id: "q1" }), doubt({ id: "q2", title: "Outra dúvida" })] }));
    await loaded();
    const second = screen.getByText("Outra dúvida").closest("[data-testid=finding]") as HTMLElement;

    await userEvent.click(within(second).getByRole("button", { name: "Bloquear" }));
    expect(post).toHaveBeenLastCalledWith("/reviews/r1/decide", { findingId: "q2", decision: "block" });

    const first = screen.getByText("O cálculo está certo?").closest("[data-testid=finding]") as HTMLElement;
    await userEvent.click(within(first).getByRole("button", { name: "Descartar" }));
    expect(post).toHaveBeenLastCalledWith("/reviews/r1/decide", { findingId: "q1", decision: "drop" });
  });

  it("dúvida já decidida não pede decisão de novo", async () => {
    open("rev", review({ phase: "reviewing", findings: [doubt({ humanDecision: "block" })] }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
  });

  it("dúvida fora de fase aberta (ready, mergeado) não mostra botões", async () => {
    open("rev", review({ phase: "merged", findings: [doubt()] }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Bloquear" })).toBeNull();
  });

  it("falha ao decidir avisa e libera os botões", async () => {
    post.mockRejectedValue(failure(409, { error: "a revisão está em ready: não há decisão pendente" }));
    open("rev", review({ phase: "reviewing", findings: [doubt()] }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Bloquear" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("a revisão está em ready: não há decisão pendente"));
    expect(screen.getByRole("button", { name: "Bloquear" })).toBeEnabled();
  });

  it("impasse mostra decisão por item travado", async () => {
    open("rev", review({
      phase: "impasse", round: 3, impasseReason: "rodadas",
      findings: [
        finding({ id: "a", title: "Travado aberto" }),
        finding({ id: "b", title: "Travado contestado", status: "contested" }),
        finding({ id: "c", title: "Já corrigido", status: "fixed" }),
        finding({ id: "d", title: "Só sugestão", severity: "suggestion" }),
      ],
    }));
    await loaded();

    // Um par por item travado (aberto ou contestado), nenhum nos outros.
    expect(screen.getAllByRole("button", { name: "Manter bloqueio" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Aceitar risco" })).toHaveLength(2);
    const fixed = screen.getByText("Já corrigido").closest("[data-testid=finding]") as HTMLElement;
    expect(within(fixed).queryByRole("button", { name: "Manter bloqueio" })).toBeNull();
    const suggestion = screen.getByText("Só sugestão").closest("[data-testid=finding]") as HTMLElement;
    expect(within(suggestion).queryByRole("button")).toBeNull();

    const contested = screen.getByText("Travado contestado").closest("[data-testid=finding]") as HTMLElement;
    await userEvent.click(within(contested).getByRole("button", { name: "Manter bloqueio" }));
    expect(post).toHaveBeenLastCalledWith("/reviews/r1/decide", { findingId: "b", decision: "keep" });
    await userEvent.click(within(contested).getByRole("button", { name: "Aceitar risco" }));
    expect(post).toHaveBeenLastCalledWith("/reviews/r1/decide", { findingId: "b", decision: "accept_risk" });
  });

  it("impasse: quem não é revisor nem owner não vê a decisão", async () => {
    for (const who of ["aut", "mer", "co"] as const) {
      open(who, review({ phase: "impasse", round: 3, impasseReason: "rodadas", findings: [finding()] }));
      await loaded();
      expect(screen.queryByRole("button", { name: "Manter bloqueio" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Aceitar risco" })).toBeNull();
      cleanup();
    }
    open("own", review({ phase: "impasse", round: 3, impasseReason: "rodadas", findings: [finding()] }));
    await loaded();
    expect(screen.getByRole("button", { name: "Manter bloqueio" })).toBeInTheDocument();
  });

  it("dúvida que o humano mandou bloquear e trava o impasse só aceita o risco (keep é recusado nela)", async () => {
    open("rev", review({
      phase: "impasse", round: 3, impasseReason: "rodadas",
      findings: [doubt({ humanDecision: "block", title: "Dúvida bloqueada" })],
    }));
    await loaded();
    const row = screen.getByText("Dúvida bloqueada").closest("[data-testid=finding]") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Aceitar risco" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Manter bloqueio" })).toBeNull();
  });

  it("fora do impasse, bloqueante aberto não pede decisão", async () => {
    open("rev", review({ phase: "fixing", findings: [finding()] }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Manter bloqueio" })).toBeNull();
  });
});

describe("ReviewPanel — avisos", () => {
  it("impasse por rodadas diz em palavras", async () => {
    open("aut", review({ phase: "impasse", round: 3, impasseReason: "rodadas" }));
    await loaded();
    expect(screen.getByText("Bateu 3 rodadas com item travado")).toBeInTheDocument();
  });

  it("impasse com outro motivo mostra o motivo como veio", async () => {
    open("aut", review({ phase: "impasse", impasseReason: "IA não respondeu" }));
    await loaded();
    expect(screen.getByText("IA não respondeu")).toBeInTheDocument();
    cleanup();

    open("aut", review({ phase: "impasse", impasseReason: "envio ao revisor falhou: sessão fechada" }));
    await loaded();
    expect(screen.getByText("envio ao revisor falhou: sessão fechada")).toBeInTheDocument();
  });

  it("Approve pendente avisa que não saiu no GitHub", async () => {
    open("aut", review({ phase: "ready", approvePending: true }));
    await loaded();
    expect(screen.getByText("Approve não publicado no GitHub — tente de novo")).toBeInTheDocument();
  });

  it("ready sem Approve pendente não avisa", async () => {
    open("aut", review({ phase: "ready" }));
    await loaded();
    expect(screen.queryByText(/Approve não publicado/)).toBeNull();
  });
});

describe("ReviewPanel — tentar de novo e cancelar", () => {
  it("tentar de novo aparece em impasse por falha e manda o POST", async () => {
    open("rev", review({ phase: "impasse", impasseReason: "IA não respondeu" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));

    expect(post).toHaveBeenCalledWith("/reviews/r1/retry");
  });

  it("tentar de novo aparece com a vez de uma IA parada (autor corrigindo, revisor sem a rodada) e manda o POST", async () => {
    open("mer", review({ phase: "fixing" }));
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(post).toHaveBeenCalledWith("/reviews/r1/retry");
    cleanup();

    open("rev", review({ phase: "reviewing", round: 2, lastSubmitRound: 1 }));
    await loaded();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    cleanup();

    // A rodada do revisor já entrou e só sobrou dúvida: a vez é de quem decide, não há o que tentar.
    open("rev", review({ phase: "reviewing", round: 2, lastSubmitRound: 2, findings: [finding({ severity: "question" })] }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  it("tentar de novo: não aparece em impasse por rodadas nem por push depois do pronto", async () => {
    for (const impasseReason of ["rodadas", "push depois do pronto"]) {
      open("rev", review({ phase: "impasse", impasseReason }));
      await loaded();
      expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
      cleanup();
    }
  });

  it("tentar de novo aparece em ready com Approve pendente, e só ali", async () => {
    open("mer", review({ phase: "ready", approvePending: true }));
    await loaded();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    cleanup();

    open("mer", review({ phase: "ready" }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  it("tentar de novo: revisor, responsável pelo merge e owner veem; autor e co-autor não", async () => {
    for (const who of ["rev", "mer", "own"] as const) {
      open(who, review({ phase: "impasse", impasseReason: "IA não respondeu" }));
      await loaded();
      expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
      cleanup();
    }
    for (const who of ["aut", "co"] as const) {
      open(who, review({ phase: "impasse", impasseReason: "IA não respondeu" }));
      await loaded();
      expect(screen.queryByRole("button", { name: "Tentar de novo" })).toBeNull();
      cleanup();
    }
  });

  it("nada a tentar (409) vira aviso e a tela relê a revisão", async () => {
    post.mockRejectedValue(failure(409, { error: "nada_a_tentar: a revisão está em fixing" }));
    open("rev", review({ phase: "impasse", impasseReason: "IA não respondeu" }));
    await loaded();
    const before = reviewGets;

    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nada_a_tentar: a revisão está em fixing"));
    await waitFor(() => expect(reviewGets).toBeGreaterThan(before));
  });

  it("cancelar pede confirmação e manda o POST", async () => {
    open("aut", review({ phase: "fixing" }));
    await loaded();

    // Dizendo que não, nada sai.
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: "Cancelar revisão" }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("PR #553");
    expect(post).not.toHaveBeenCalled();

    // Confirmando, vai.
    await userEvent.click(screen.getByRole("button", { name: "Cancelar revisão" }));
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith("/reviews/r1/cancel");
  });

  it("cancelar: revisor, autor, responsável pelo merge e owner veem; o co-autor não", async () => {
    for (const who of ["rev", "aut", "mer", "own"] as const) {
      open(who, review({ phase: "ready" }));
      await loaded();
      expect(screen.getByRole("button", { name: "Cancelar revisão" })).toBeInTheDocument();
      cleanup();
    }
    open("co", review({ phase: "ready", coauthorUserId: "u-co" }));
    await loaded();
    expect(screen.queryByRole("button", { name: "Cancelar revisão" })).toBeNull();
  });

  it("cancelar vale em qualquer fase ativa", async () => {
    for (const phase of ["reviewing", "fixing", "ready", "impasse"] as const) {
      open("rev", review({ phase }));
      await loaded();
      expect(screen.getByRole("button", { name: "Cancelar revisão" })).toBeInTheDocument();
      cleanup();
    }
  });

  it("cancelar com sucesso põe a revisão cancelada na tela", async () => {
    post.mockResolvedValue({ review: review({ phase: "cancelled" }) });
    open("aut", review({ phase: "fixing" }));
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Cancelar revisão" }));

    expect(await screen.findByText("Revisão cancelada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar revisão" })).toBeNull();
  });
});

describe("ReviewPanel — leitura periódica", () => {
  it("relê a cada 3s enquanto o revisor ou o autor trabalham, e a tela acompanha", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open("rev", review({ phase: "fixing", round: 2 }));
    await loaded();
    expect(screen.getByText("rodada 2/3")).toBeInTheDocument();

    current = review({ phase: "ready", round: 2 });
    await tick(3_100);

    expect(await screen.findByText("pronto pra merge")).toBeInTheDocument();
  });

  it("em ready e em impasse, parada, continua relendo, com calma (10s): a revisão anda sozinha (merge no GitHub, push)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const phase of ["ready", "impasse"] as const) {
      reviewGets = 0;
      open("rev", review({ phase }));
      await loaded();
      const seen = reviewGets;
      await tick(3_100);
      expect(reviewGets).toBe(seen);
      await tick(27_000);
      expect(reviewGets).toBeGreaterThanOrEqual(seen + 3);
      cleanup();
    }
  });

  it("com uma IA trabalhando, mesmo em ready, a leitura volta a cada 3s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    working = { author: true, reviewer: false };
    open("rev", review({ phase: "ready" }));
    await loaded();
    const seen = reviewGets;
    await tick(3_100);
    expect(reviewGets).toBeGreaterThan(seen);
  });

  it("mergeada ou cancelada não relê: acabou", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const phase of ["merged", "cancelled"] as const) {
      reviewGets = 0;
      open("rev", review({ phase }));
      await loaded();
      const seen = reviewGets;
      await tick(10_000);
      expect(reviewGets).toBe(seen);
      cleanup();
    }
  });

  it("pronto, e a IA do autor começa a mexer no PR: a pill vira IA mexendo e o merge espera ela terminar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open("mer", review({ phase: "ready", round: 1 }));
    await loaded();
    expect(screen.getByText("pronto pra merge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeEnabled();

    working = { author: true, reviewer: false };
    await tick(10_100);
    expect(await screen.findByText("IA mexendo")).toBeInTheDocument();
    expect(screen.queryByText("pronto pra merge")).toBeNull();
    expect(screen.getByText(/A IA do autor está mexendo no PR/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeDisabled();
    expect(screen.getByText(/Espere a IA do autor terminar/)).toBeInTheDocument();

    // Terminou sem empurrar nada: volta a pronto e o merge libera.
    working = { author: false, reviewer: false };
    await tick(3_100);
    expect(await screen.findByText("pronto pra merge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergear na dev" })).toBeEnabled();
    expect(screen.queryByText(/Espere a IA do autor terminar/)).toBeNull();
  });

  it("a IA do autor empurrou depois do pronto: o painel mostra a rodada 2 com o revisor conferindo, sem recarregar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open("rev", review({ phase: "ready", round: 1, lastSubmitRound: 1 }));
    await loaded();
    expect(screen.getByText("pronto pra merge")).toBeInTheDocument();

    current = review({
      phase: "reviewing", round: 2, lastSubmitRound: 1,
      log: [{ at: 3, round: 2, who: "system", text: "O autor empurrou depois do pronto (head bbbbbbb). Rodada 2 de 3: o revisor confere o que entrou." }],
    });
    await tick(10_100);
    expect(await screen.findByText("rodada 2/3")).toBeInTheDocument();
    expect(screen.getByText("O revisor confere só o que mudou desde a rodada 1.")).toBeInTheDocument();
    expect(screen.getByText(/O autor empurrou depois do pronto/)).toBeInTheDocument();
  });

  it("sugestão aplicada e conferida pelo revisor aparece corrigida na próxima leitura", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const suggestion = finding({ id: "f1", severity: "suggestion", title: "nome de variável confuso" });
    open("rev", review({ phase: "reviewing", round: 2, findings: [suggestion] }));
    await loaded();
    const row = () => screen.getAllByTestId("finding").find((li) => li.textContent?.includes("nome de variável confuso"))!;
    expect(row()).toHaveAttribute("data-status", "open");

    current = review({ phase: "ready", round: 2, findings: [{ ...suggestion, status: "fixed", reviewerReply: "renomeado" }] });
    await tick(3_100);
    await waitFor(() => expect(row()).toHaveAttribute("data-status", "fixed"));
    expect(within(row()).getByText("corrigido")).toBeInTheDocument();
  });

  it("quando a fase ou a rodada mudam, a lista de cards do board é relida (a linha da barra lateral acompanha)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = open("rev", review({ phase: "ready", round: 1 }));
    await loaded();
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    await tick(10_100);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["board", "cards"] });

    current = review({ phase: "reviewing", round: 2 });
    await tick(10_100);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["board", "cards"] }));
  });
});

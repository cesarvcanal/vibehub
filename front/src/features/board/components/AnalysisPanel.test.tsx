import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiReject, renderApp, setupState } from "@/test/render";
import { AnalysisPanel } from "./AnalysisPanel";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import {
  ANALYSIS_DIMENSIONS, type AnalysisConversationResponse, type AnalysisReadModel, type AnalysisReport, type CardAnalysisResponse,
} from "@/api/types";

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

const doneReport = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
  cardId: "c1", prUrl: "https://github.com/acme/w/pull/312", prNumber: 312, analysedSha: "a1b2c3d".padEnd(40, "0"),
  stage: "done", summary: "Login por SSO no lugar da senha local.", refutedCount: 5, updatedAt: 1,
  dimensions: [
    { key: "correctness", status: "ran" }, { key: "security", status: "ran" }, { key: "performance", status: "ran" },
    { key: "contracts", status: "ran" }, { key: "tests", status: "ran" },
    { key: "repoRules", status: "skipped", reason: "o diff só toca configuração" },
  ],
  findings: [
    {
      id: "f1", severity: "blocking", dimension: "correctness", status: "fixed", commit: "9f3e2c1",
      title: "Sessão SSO não expira com o token", problem: "Quem perde o acesso continua logado.",
      file: "back/src/auth/sso.ts", line: 84, proof: { kind: "failing_test", ref: "sso.test.ts" }, fix: "Gravar expiresAt.",
    },
    {
      id: "f3", severity: "question", dimension: "security", status: "open",
      title: "Conta local continua aceitando senha?", problem: "Pode ser a intenção ou uma brecha.",
    },
  ],
  ...over,
});

const readModel = (
  report: AnalysisReport, verdict: AnalysisReadModel["verdict"], health: Partial<AnalysisReadModel["health"]> = {},
  uncheckedDimensions: AnalysisReadModel["uncheckedDimensions"] = [],
): AnalysisReadModel => ({
  analysis: report,
  health: { correctness: "ok", security: "attention", performance: "ok", contracts: "ok", tests: "ok", repoRules: "skipped", ...health },
  verdict,
  uncheckedDimensions,
  canMerge: false,
  merging: false,
});

function renderPanel(
  analysisAnswer: CardAnalysisResponse | Promise<CardAnalysisResponse>,
  onClose: () => void = () => {},
  answerConversation: () => AnalysisConversationResponse | Promise<AnalysisConversationResponse> = () => ({ conversation: null }),
) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
    if (url === "/setup/state") return setupState();
    if (url === "/cards/c1/analysis") return analysisAnswer;
    if (url === "/cards/c1/analysis/conversation") return answerConversation();
    throw new Error(`unexpected ${url}`);
  });
  return renderApp(<AnalysisPanel cardId="c1" onClose={onClose} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("pt-BR");
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(LANGUAGE_KEY);
  setLanguage("en");
});

describe("painel da análise de PR", () => {
  it("mostra o veredito, as contagens e o estado de cada dimensão com o motivo de quem não rodou", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    expect(await screen.findByRole("heading", { name: "Análise do PR #312" })).toBeInTheDocument();
    expect(screen.getByText("Não apto")).toBeInTheDocument();
    expect(screen.getByText("1 corrigido")).toBeInTheDocument();
    expect(screen.getByText("1 dúvida aberta")).toBeInTheDocument();
    expect(screen.getByText("5 derrubados na verificação")).toBeInTheDocument();
    const dimensions = screen.getByRole("list", { name: "Dimensões revisadas" });
    expect(within(dimensions).getByText("Segurança")).toBeInTheDocument();
    expect(within(dimensions).getByText("atenção")).toBeInTheDocument();
    expect(within(dimensions).getByText("fora do diff")).toBeInTheDocument();
    expect(within(dimensions).getByText("o diff só toca configuração")).toBeInTheDocument();
  });

  it("o resumo em tópicos aparece como lista, com o código marcado", async () => {
    renderPanel(readModel(doneReport({ summary: "- troca a senha pelo `sso`\n- sessão expira com o token" }), "not_apt"));
    await screen.findByRole("heading", { name: "Análise do PR #312" });
    expect(screen.getByText("troca a senha pelo", { exact: false }).closest("li")).toBeInTheDocument();
    expect(screen.getByText("sessão expira com o token").tagName).toBe("LI");
    expect(screen.getByText("sso").tagName).toBe("CODE");
  });

  it("dimensão que rodou com achado não verificado aparece em atenção, com o motivo, ao lado do não apto que o servidor manda", async () => {
    const dimensions = doneReport().dimensions.map((dimension) => dimension.key === "tests"
      ? { ...dimension, unverifiedCount: 2, reason: "2 achados sem veredito (o verificador não respondeu)" }
      : dimension);
    renderPanel(readModel(doneReport({ dimensions }), "not_apt", { tests: "attention" }, ["tests"]));
    expect(await screen.findByText("Não apto")).toBeInTheDocument();
    const testsDimension = within(screen.getByRole("list", { name: "Dimensões revisadas" })).getByText("Testes").closest("li")!;
    expect(within(testsDimension).getByText("atenção")).toBeInTheDocument();
    expect(within(testsDimension).getByText("2 achados sem veredito (o verificador não respondeu)")).toBeInTheDocument();
  });

  it("agrupa os achados por classe, com arquivo:linha, prova e o commit que corrigiu", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    const blockers = await screen.findByRole("region", { name: "Bloqueantes" });
    expect(within(blockers).getByText("Sessão SSO não expira com o token")).toBeInTheDocument();
    expect(within(blockers).getByText("back/src/auth/sso.ts:84")).toBeInTheDocument();
    expect(within(blockers).getByText("corrigido em 9f3e2c1")).toBeInTheDocument();
    expect(within(blockers).getByText("teste que falha · sso.test.ts")).toBeInTheDocument();
    const questions = screen.getByRole("region", { name: "Dúvidas" });
    expect(within(questions).getByText("esperando decisão")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sugestões" })).not.toBeInTheDocument();
  });

  it("dúvida que a pessoa decidiu mostra a decisão dela no lugar de \"esperando decisão\" e sai da contagem de dúvidas abertas", async () => {
    const findings = doneReport().findings.map((finding) => finding.id === "f3"
      ? { ...finding, status: "decided" as const, decision: "fica: a conta local é só do admin" }
      : finding);
    renderPanel(readModel(doneReport({ findings }), "apt"));
    const questions = await screen.findByRole("region", { name: "Dúvidas" });
    expect(within(questions).getByText("decidido: fica: a conta local é só do admin")).toBeInTheDocument();
    expect(within(questions).queryByText("esperando decisão")).not.toBeInTheDocument();
    expect(screen.queryByText("1 dúvida aberta")).not.toBeInTheDocument();
  });

  it("a prova mostra o detalhe que o achado traz, junto do tipo e da referência", async () => {
    const [fixedBlocking, openQuestion] = doneReport().findings;
    const withDetail = { ...fixedBlocking!, proof: { kind: "scenario" as const, ref: "sso.ts:84", detail: "token expirado continua entrando" } };
    renderPanel(readModel(doneReport({ findings: [withDetail, openQuestion!] }), "not_apt"));
    const blockers = await screen.findByRole("region", { name: "Bloqueantes" });
    expect(within(blockers).getByText("cenário · sso.ts:84")).toBeInTheDocument();
    expect(within(blockers).getByText("token expirado continua entrando")).toBeInTheDocument();
  });

  it("o corpo tem overflow-y-auto, overflow-x-hidden e overflow-wrap:anywhere, para o caminho longo quebrar em vez de rolar de lado", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    const body = (await screen.findByRole("list", { name: "Dimensões revisadas" })).parentElement;
    expect(body).toHaveClass("overflow-y-auto", "overflow-x-hidden", "[overflow-wrap:anywhere]");
  });

  it("frota indisponível mostra o motivo e o que fazer, sem achado nenhum", async () => {
    renderPanel(readModel(
      doneReport({ stage: "fleet_unavailable", unavailableReason: "the Workflow tool is not available", findings: [], dimensions: [] }),
      "not_apt",
      { correctness: "not_run", security: "not_run", performance: "not_run", contracts: "not_run", tests: "not_run", repoRules: "not_run" },
      [...ANALYSIS_DIMENSIONS],
    ));
    expect(await screen.findByText("A frota de agentes não rodou neste card")).toBeInTheDocument();
    expect(screen.getByText("the Workflow tool is not available")).toBeInTheDocument();
    expect(screen.getByText(
      "Leia o motivo e resolva o que ele aponta; depois, peça a análise de novo na lista de PRs do projeto.",
    )).toBeInTheDocument();
    expect(screen.getByText("Frota indisponível")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Dimensões revisadas" })).not.toBeInTheDocument();
  });

  it("card sem relatório ainda diz que a frota não gravou e aponta o painel de workflow", async () => {
    renderPanel({ analysis: null });
    expect(await screen.findByText(
      "A frota de agentes ainda não gravou o relatório. O andamento aparece no painel de workflow do card.",
    )).toBeInTheDocument();
  });

  it("enquanto a leitura não chega, diz carregando e nada do relatório", async () => {
    renderPanel(new Promise<CardAnalysisResponse>(() => {}));
    expect(await screen.findByText("Carregando")).toBeInTheDocument();
    expect(screen.queryByText(/A frota de agentes ainda não gravou o relatório/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Dimensões revisadas" })).not.toBeInTheDocument();
  });

  it("leitura que falhou mostra o erro do servidor, nunca o painel vazio de sem relatório", async () => {
    renderPanel(Promise.reject(apiReject(500, "analysis store unreadable")));
    expect(await screen.findByText("analysis store unreadable")).toBeInTheDocument();
    expect(screen.queryByText("Carregando")).not.toBeInTheDocument();
    expect(screen.queryByText(/A frota de agentes ainda não gravou o relatório/)).not.toBeInTheDocument();
  });

  it("o botão de fechar fecha o painel", async () => {
    const onClose = vi.fn();
    renderPanel(readModel(doneReport(), "not_apt"), onClose);
    await userEvent.click(await screen.findByRole("button", { name: "Fechar a análise" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("merge pelo painel da análise", () => {
  const aptRead = (over: Partial<AnalysisReadModel> = {}): AnalysisReadModel => ({
    ...readModel(doneReport({ findings: [] }), "apt", { security: "ok" }), canMerge: true, ...over,
  });

  it("sem canMerge o botão não aparece", async () => {
    renderPanel(aptRead({ canMerge: false }));
    expect(await screen.findByText("Apto")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mergear o PR #312" })).not.toBeInTheDocument();
  });

  it("PR já mergeado diz que foi mergeado, sem o botão", async () => {
    renderPanel(aptRead({ canMerge: false, mergedAt: 1 }));
    expect(await screen.findByText("PR #312 mergeado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mergear o PR #312" })).not.toBeInTheDocument();
  });

  it("com canMerge o clique pede o merge do card, trava o botão enquanto envia e, mergeado, relê a análise", async () => {
    const mergeAnswer: { resolve: (body: unknown) => void } = { resolve: () => undefined };
    post.mockReturnValue(new Promise((resolve) => {
      mergeAnswer.resolve = resolve;
    }));
    renderPanel(aptRead());
    await userEvent.click(await screen.findByRole("button", { name: "Mergear o PR #312" }));
    expect(post).toHaveBeenCalledWith("/cards/c1/analysis/merge");
    const sending = screen.getByRole("button", { name: "Mergeando…" });
    expect(sending).toBeDisabled();
    const readsBefore = get.mock.calls.filter(([url]) => url === "/cards/c1/analysis").length;
    mergeAnswer.resolve({ result: { merged: true, reason: "merged", branch: "dev", cardBranch: "feat/sso" } });
    expect(await screen.findByText("PR #312 mergeado; o card foi para Concluído.")).toBeInTheDocument();
    await vi.waitFor(() => expect(get.mock.calls.filter(([url]) => url === "/cards/c1/analysis").length).toBeGreaterThan(readsBefore));
  });

  it("merge recusado mostra o motivo do servidor e devolve o botão", async () => {
    post.mockRejectedValue(apiReject(409, "CI vermelho no PR"));
    renderPanel(aptRead());
    await userEvent.click(await screen.findByRole("button", { name: "Mergear o PR #312" }));
    expect(await screen.findByText("CI vermelho no PR")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergear o PR #312" })).toBeEnabled();
  });

  it("com o servidor dizendo que o merge roda, o painel mostra Mergeando travado e o aviso do merge, mesmo sem ter clicado", async () => {
    renderPanel(aptRead({ merging: true }));
    expect(await screen.findByRole("button", { name: "Mergeando…" })).toBeDisabled();
    expect(screen.getByText("Mergeando no GitHub, preso ao commit que a análise conferiu.")).toBeInTheDocument();
  });

  const SHA = doneReport().analysedSha;

  it("caso real (PR #649): testes do merge rodando no commit da análise travam o botão com o aviso, e o painel relê sozinho até o veredito", async () => {
    const reads = { count: 0 };
    get.mockImplementation(async (url: string) => {
      if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
      if (url === "/setup/state") return setupState();
      if (url === "/cards/c1/analysis/conversation") return { conversation: null };
      reads.count += 1;
      return aptRead({
        mergeGate: reads.count > 1
          ? { cardId: "c1", analysedSha: SHA, sha: "c0ffee1".padEnd(40, "0"), state: "passed", at: 2 }
          : { cardId: "c1", analysedSha: SHA, state: "running", at: 1 },
      });
    });
    renderApp(<AnalysisPanel cardId="c1" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Testes do merge rodando…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Testes do merge rodando no commit que a análise conferiu: o botão libera quando ficarem verdes.");
    expect(await screen.findByRole("button", { name: "Mergear o PR #312" }, { timeout: 8_000 })).toBeEnabled();
    expect(screen.getByText("Testes do merge verdes no commit que a análise conferiu (c0ffee1).")).toBeInTheDocument();
  });

  it("testes do merge vermelhos no commit da análise: mostram a saída, não oferecem o merge, e 'Rodar os testes de novo' pede o gate e relê", async () => {
    post.mockResolvedValue({ mergeGate: { cardId: "c1", analysedSha: SHA, state: "running", at: 2 } });
    renderPanel(aptRead({ mergeGate: { cardId: "c1", analysedSha: SHA, state: "failed", output: "FAIL src/pix.test.ts", at: 1 } }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Os testes do merge falharam: o merge fica barrado até eles passarem.");
    expect(within(alert).getByText("FAIL src/pix.test.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mergear o PR #312" })).not.toBeInTheDocument();
    const readsBefore = get.mock.calls.filter(([url]) => url === "/cards/c1/analysis").length;
    await userEvent.click(screen.getByRole("button", { name: "Rodar os testes de novo" }));
    expect(post).toHaveBeenCalledWith("/cards/c1/analysis/merge-gate");
    await vi.waitFor(() => expect(get.mock.calls.filter(([url]) => url === "/cards/c1/analysis").length).toBeGreaterThan(readsBefore));
  });

  it("em inglês o estado dos testes do merge sai pelo i18n", async () => {
    setLanguage("en");
    renderPanel(aptRead({ mergeGate: { cardId: "c1", analysedSha: SHA, state: "failed", output: "x", at: 1 } }));
    expect(await screen.findByRole("button", { name: "Run the checks again" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("The merge checks failed: the merge stays blocked until they pass.");
  });

  it.each<[string, Error]>([
    ["409 merging (o clique anterior ainda roda)", Object.assign(new Error("409"), { response: { status: 409, data: { error: "merge já em andamento", reason: "merging" } } })],
    ["proxy que desistiu da requisição longa", apiReject(524, "")],
  ])("clique com resposta %s não vira erro: relê e segue em Mergeando enquanto o servidor diz merging", async (_case, failure) => {
    post.mockRejectedValue(failure);
    const reads = { count: 0 };
    get.mockImplementation(async (url: string) => {
      if (url === "/auth/me") return { user: { id: "u1", username: "mussa", role: "member" } };
      if (url === "/setup/state") return setupState();
      if (url === "/cards/c1/analysis/conversation") return { conversation: null };
      reads.count += 1;
      return aptRead({ merging: reads.count > 1 });
    });
    renderApp(<AnalysisPanel cardId="c1" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mergear o PR #312" }));
    expect(await screen.findByRole("button", { name: "Mergeando…" })).toBeDisabled();
    expect(screen.queryByText("merge já em andamento")).not.toBeInTheDocument();
  });

  it("último merge barrado no commit analisado: o painel diz o motivo e a saída antes do clique e oferece tentar de novo", async () => {
    renderPanel(aptRead({ lastMergeRefusal: {
      cardId: "c1", analysedSha: doneReport().analysedSha, reason: "gate", output: "npm test estourou 585 s", by: "mussa", at: 1,
    } }));
    expect(await screen.findByText("O último merge não saiu: os testes do gate falharam ou estouraram o tempo.")).toBeInTheDocument();
    expect(screen.getByText("npm test estourou 585 s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar o merge do PR #312 de novo" })).toBeEnabled();
  });

  it("último merge barrado por conflito com a base: o painel diz o conflito e o que fazer, sem a saída do gh", async () => {
    renderPanel(aptRead({ lastMergeRefusal: {
      cardId: "c1", analysedSha: doneReport().analysedSha, reason: "conflict", output: "o PR tem conflito com dev", by: "mussa", at: 1,
    } }));
    expect(await screen.findByText(
      "O último merge não saiu: o PR está em conflito com a base. Peça ao card do PR para trazer a base (git merge), testar e subir; depois tente de novo.",
    )).toBeInTheDocument();
  });

  it("resposta perdida e servidor sem merge rodando, sem recusa e sem merge: avisa que o resultado não foi confirmado", async () => {
    post.mockRejectedValue(apiReject(502, ""));
    renderPanel(aptRead());
    await userEvent.click(await screen.findByRole("button", { name: "Mergear o PR #312" }));
    expect(await screen.findByText("Não deu para confirmar o merge: a conexão caiu e o servidor não tem merge rodando nem recusa registrada. Confira o PR no GitHub antes de tentar de novo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mergear o PR #312" })).toBeEnabled();
  });

  it("recusa por outro motivo que não o gate mostra o texto genérico e a saída, nunca o código interno do motivo", async () => {
    renderPanel(aptRead({
      lastMergeRefusal: { cardId: "c1", analysedSha: doneReport().analysedSha, reason: "push_failed", output: "rejected: non-fast-forward", by: "mussa", at: 1 },
    }));
    expect(await screen.findByText("O último merge não saiu. Saída do vibehub:")).toBeInTheDocument();
    expect(screen.getByText("rejected: non-fast-forward")).toBeInTheDocument();
    expect(screen.queryByText(/push_failed/)).not.toBeInTheDocument();
  });

  it("em inglês o botão e o resultado saem pelo i18n", async () => {
    setLanguage("en");
    post.mockResolvedValue({ result: { merged: true, reason: "merged", branch: "dev", cardBranch: "feat/sso" } });
    renderPanel(aptRead());
    await userEvent.click(await screen.findByRole("button", { name: "Merge PR #312" }));
    expect(await screen.findByText("PR #312 merged; the card moved to Done.")).toBeInTheDocument();
  });
});

describe("aba Conversa: a frota conversando como um chat em grupo", () => {
  const fleetTalk: AnalysisConversationResponse = {
    conversation: {
      runId: "wf_a1", finished: false,
      agents: [
        { id: "a1", label: "revisão:security", phase: "Revisão", status: "done", modelLabel: "Sonnet 5.5" },
        { id: "a2", label: "verificação:security · token vaza", phase: "Verificação", status: "running", modelLabel: "Opus 5.5" },
      ],
      items: [
        { agentId: "a1", at: 1, kind: "thinking" },
        { agentId: "a1", at: 2, kind: "tool", tool: "Read", target: "back/src/auth.ts" },
        { agentId: "a1", at: 3, kind: "result", text: "export function login() {}" },
        { agentId: "a1", at: 4, kind: "text", text: "O token vaza no log." },
        { agentId: "a2", at: 5, kind: "text", text: "Refutado: o log mascara o token." },
      ],
    },
  };

  const openConversation = async () => {
    await userEvent.click(await screen.findByRole("tab", { name: "Conversa" }));
  };

  it("o painel abre no relatório e só lê a conversa quando a aba é aberta", async () => {
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => fleetTalk);
    expect(await screen.findByRole("tab", { name: "Relatório" })).toHaveAttribute("aria-selected", "true");
    expect(get).not.toHaveBeenCalledWith("/cards/c1/analysis/conversation");
    await openConversation();
    expect(await screen.findByText("O token vaza no log.")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/cards/c1/analysis/conversation");
  });

  it("cada fala é um balão com quem falou e o modelo; ferramenta não vira balão e quem ainda trabalha está digitando, no grupo da própria fala", async () => {
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => fleetTalk);
    await openConversation();
    const messages = await screen.findAllByTestId("fleet-chat-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveTextContent("Revisão de Segurança");
    expect(messages[0]).toHaveTextContent("Sonnet 5.5");
    expect(messages[0]).toHaveTextContent("O token vaza no log.");
    expect(messages[1]).toHaveTextContent("Verificação de Segurança");
    expect(messages[1]).toHaveTextContent("Opus 5.5");
    expect(screen.queryByText(/Read · back\/src\/auth.ts/)).toBeNull();
    expect(screen.queryByText("export function login() {}")).toBeNull();
    const typing = screen.getByTestId("fleet-chat-typing");
    expect(typing).toHaveTextContent("digitando");
    expect(typing).not.toHaveTextContent("Verificação de Segurança");
    expect(screen.getByText("Frota conversando · 1 de 2 agentes responderam")).toBeInTheDocument();
  });

  it("quem trabalha com uma ferramenta na mão diz qual, no digitando", async () => {
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => ({
      conversation: { ...fleetTalk.conversation!, items: [{ agentId: "a2", at: 1, kind: "tool", tool: "Read", target: "back/src/log.ts" }] },
    }));
    await openConversation();
    expect(await screen.findByTestId("fleet-chat-typing")).toHaveTextContent("Read · back/src/log.ts");
  });

  it("fala em JSON (achados ou veredito) vira a lista de achados e o veredito com a evidência, citando o achado", async () => {
    const structured: AnalysisConversationResponse = {
      conversation: {
        ...fleetTalk.conversation!,
        items: [
          { agentId: "a1", at: 1, kind: "text", text: JSON.stringify({ findings: [{ title: "token vaza no log" }] }) },
          { agentId: "a2", at: 2, kind: "text", text: JSON.stringify({ confirmed: false, evidence: "o log mascara o token" }) },
        ],
      },
    };
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => structured);
    await openConversation();
    const messages = await screen.findAllByTestId("fleet-chat-message");
    expect(messages[0]).toHaveTextContent("1 achado");
    expect(within(messages[0]!).getByRole("listitem")).toHaveTextContent("token vaza no log");
    expect(within(messages[1]!).getByText("Derrubado")).toBeInTheDocument();
    expect(messages[1]).toHaveTextContent("o log mascara o token");
    expect(within(messages[1]!).getByRole("button", { name: "Ver a fala respondida: token vaza" })).toBeInTheDocument();
  });

  it("fala em markdown sai renderizada e a longa vem recolhida, com ver mais e ver menos", async () => {
    const longSpeech = `Achei **2 problemas**:\n\n${Array.from({ length: 12 }, (_, line) => `- item ${line + 1}`).join("\n")}`;
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => ({
      conversation: { ...fleetTalk.conversation!, items: [{ agentId: "a1", at: 1, kind: "text", text: longSpeech }] },
    }));
    await openConversation();
    const [message] = await screen.findAllByTestId("fleet-chat-message");
    expect(within(message!).getByText("2 problemas").tagName).toBe("STRONG");
    expect(within(message!).getAllByRole("listitem")).toHaveLength(12);
    expect(within(message!).getByTestId("fleet-chat-speech")).toHaveAttribute("data-collapsed", "true");
    await userEvent.click(within(message!).getByRole("button", { name: "ver mais" }));
    expect(within(message!).getByTestId("fleet-chat-speech")).toHaveAttribute("data-collapsed", "false");
    expect(within(message!).getByRole("button", { name: "ver menos" })).toBeInTheDocument();
  });

  it("card sem frota diz que a frota ainda não rodou", async () => {
    renderPanel(readModel(doneReport(), "not_apt"));
    await openConversation();
    expect(await screen.findByText("A frota de agentes ainda não rodou neste card.")).toBeInTheDocument();
  });

  it("leitura que falhou mostra o erro do servidor", async () => {
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => Promise.reject(apiReject(502, "runner parado")));
    await openConversation();
    expect(await screen.findByText("runner parado")).toBeInTheDocument();
  });

  it("em inglês a aba e o estado da frota saem pelo i18n", async () => {
    setLanguage("en");
    renderPanel(readModel(doneReport(), "not_apt"), undefined, () => ({
      conversation: { ...fleetTalk.conversation!, finished: true, agents: fleetTalk.conversation!.agents.map((agent) => ({ ...agent, status: "done" as const })) },
    }));
    await userEvent.click(await screen.findByRole("tab", { name: "Conversation" }));
    expect(await screen.findByText("Fleet finished · 2 of 2 agents answered")).toBeInTheDocument();
    expect(screen.getAllByTestId("fleet-chat-message")).toHaveLength(2);
    expect(screen.queryByTestId("fleet-chat-typing")).toBeNull();
  });
});

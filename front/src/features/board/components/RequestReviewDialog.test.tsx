import { useState } from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { apiReject, renderApp, setupState } from "@/test/render";
import { RequestReviewDialog } from "./RequestReviewDialog";
import { CARDS_PREFIX_KEY } from "@/features/board/api";
import { LANGUAGE_KEY, setLanguage } from "@/i18n";
import type { CardPr, Person } from "@/api/types";

// Two queries (the session and the people) stand between opening this dialog and its first select,
// on a machine shared with the rest of the suite.
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

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const MUSSA = { id: "u1", username: "mussa", role: "member" };
const PEOPLE: Person[] = [
  { id: "u1", username: "mussa", canReview: true },
  { id: "u2", username: "albert", canReview: true },
  { id: "u3", username: "kim", canReview: false },
];
const PR: CardPr = {
  number: 553, url: "https://github.com/acme/erp/pull/553", base: "dev", branch: "card/pedidos", openedAt: 1,
};

function serve(people: Person[] = PEOPLE, me = MUSSA) {
  get.mockImplementation(async (url: string) => {
    if (url === "/auth/me") return { user: me };
    if (url === "/setup/state") return setupState();
    if (url === "/cards/c1/people") return { people };
    throw new Error(`unexpected ${url}`);
  });
}

function open(props: { actorUserId?: string; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const view = renderApp(
    <RequestReviewDialog cardId="c1" pr={PR} actorUserId={props.actorUserId} open onClose={onClose} />,
  );
  return { ...view, onClose };
}

const select = (name: RegExp) => screen.getByLabelText(name) as HTMLSelectElement;
const startButton = () => screen.getByRole("button", { name: "Iniciar revisão" });

/** The people arrived: the selects exist and the session is known. */
async function loaded() {
  await screen.findByLabelText(/^Revisor/);
  await waitFor(() => expect(select(/^Responsável pelo merge/).value).not.toBe(""));
}

beforeEach(() => {
  vi.clearAllMocks();
  setLanguage("pt-BR");
});
afterEach(() => {
  // Unmount BEFORE the language flips back: a mounted `useT()` would re-render outside act().
  cleanup();
  setLanguage("en");
  localStorage.removeItem(LANGUAGE_KEY);
});

describe("RequestReviewDialog", () => {
  it("suggests who is logged in as reviewer and merger, the card's actor as author, and nobody as co-author", async () => {
    serve();
    open({ actorUserId: "u2" });
    await loaded();

    expect(select(/^Revisor/).value).toBe("u1");
    expect(select(/^Quem corrige/).value).toBe("u2");
    expect(select(/^Co-autor/).value).toBe("");
    expect(select(/^Responsável pelo merge/).value).toBe("u1");
    expect(startButton()).toBeEnabled();
  });

  it("names the PR it is about and says nobody merges without you", async () => {
    serve();
    open({ actorUserId: "u2" });
    expect(await screen.findByText("Pedir revisão do PR #553")).toBeInTheDocument();
    expect(screen.getByText(/Ninguém mergeia sem você/)).toBeInTheDocument();
  });

  it("leaves the reviewer empty when the logged-in person is the author", async () => {
    serve();
    open({ actorUserId: "u1" });
    await loaded();

    expect(select(/^Quem corrige/).value).toBe("u1");
    expect(select(/^Revisor/).value).toBe("");
    expect(startButton()).toBeDisabled();
  });

  it("leaves the reviewer empty when the logged-in person has no Claude account to review on", async () => {
    serve(PEOPLE, { id: "u3", username: "kim", role: "member" });
    open({ actorUserId: "u2" });
    await screen.findByLabelText(/^Revisor/);
    await waitFor(() => expect(select(/^Responsável pelo merge/).value).toBe("u3"));

    expect(select(/^Revisor/).value).toBe("");
  });

  it("leaves the author empty when the card has no recorded actor", async () => {
    serve();
    open();
    await loaded();

    expect(select(/^Quem corrige/).value).toBe("");
    expect(startButton()).toBeDisabled();
  });

  it("leaves the author empty when the actor no longer reaches the card", async () => {
    serve();
    open({ actorUserId: "gone" });
    await loaded();

    expect(select(/^Quem corrige/).value).toBe("");
  });

  it("a person without a Claude account shows in the reviewer list, disabled", async () => {
    serve();
    open({ actorUserId: "u2" });
    await loaded();

    expect(within(select(/^Revisor/)).getByRole("option", { name: /kim/ })).toBeDisabled();
    // ...but can still fix, co-author or merge: the account is only the reviewer's session.
    const authorOptions = Array.from(select(/^Quem corrige/).options);
    expect(authorOptions.find((o) => o.value === "u3")).not.toBeDisabled();
    expect(Array.from(select(/^Co-autor/).options).find((o) => o.value === "u3")).not.toBeDisabled();
  });

  it("escolher o autor como revisor mostra o erro e trava o botão", async () => {
    serve();
    open({ actorUserId: "u2" });
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.selectOptions(select(/^Revisor/), "u2");

    expect(screen.getByRole("alert")).toHaveTextContent("O autor do PR não pode revisar o próprio PR.");
    expect(startButton()).toBeDisabled();

    // Fixing the pick clears the error and frees the button.
    await userEvent.selectOptions(select(/^Revisor/), "u1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startButton()).toBeEnabled();
  });

  it("changing the author onto the reviewer trips the same error", async () => {
    serve();
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.selectOptions(select(/^Quem corrige/), "u1");

    expect(screen.getByRole("alert")).toHaveTextContent("O autor do PR não pode revisar o próprio PR.");
    expect(startButton()).toBeDisabled();
  });

  it("iniciar manda os 4 papéis pro POST", async () => {
    serve();
    post.mockResolvedValue({ review: { id: "r1" } });
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.selectOptions(select(/^Co-autor/), "u3");
    await userEvent.click(startButton());

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/cards/c1/review", {
        prNumber: 553,
        reviewerUserId: "u1",
        authorUserId: "u2",
        coauthorUserId: "u3",
        mergerUserId: "u1",
      }),
    );
  });

  it("leaves coauthorUserId out of the body when nobody is chosen — an empty string is refused", async () => {
    serve();
    post.mockResolvedValue({ review: { id: "r1" } });
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({ prNumber: 553, reviewerUserId: "u1", authorUserId: "u2", mergerUserId: "u1" });
    expect("coauthorUserId" in body).toBe(false);
  });

  it("after starting: refreshes the cards and the review, closes, and says so", async () => {
    serve();
    post.mockResolvedValue({ review: { id: "r1" } });
    const { queryClient, onClose } = open({ actorUserId: "u2" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await loaded();

    await userEvent.click(startButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CARDS_PREFIX_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["card-review", "c1"] });
    expect(toast.success).toHaveBeenCalledWith("Revisão do PR #553 iniciada");
  });

  it("a double click on Iniciar revisão sends one request", async () => {
    serve();
    let finish: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());
    await waitFor(() => expect(screen.getByRole("button", { name: "Iniciando…" })).toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Iniciando…" }));
    finish({ review: { id: "r1" } });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub", /não tem uma conta Claude própria/],
    ["revisao_ativa: já existe uma revisão em andamento do PR #553 neste card", /Já existe uma revisão em andamento/],
    ["sem_pr: o card não tem o PR #553", /O card não tem esse PR/],
    ["pr_mergeado: o PR #553 já foi mergeado", /^Esse PR já foi mergeado/],
    ["revisor_igual_autor: quem revisa não pode ser quem corrige", /O autor do PR não pode revisar o próprio PR/],
  ])("server refusal %s shows inline and keeps the dialog open", async (message, expected) => {
    serve();
    post.mockRejectedValue(apiReject(400, message));
    const { onClose } = open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // The person can try again once they changed something.
    expect(startButton()).toBeEnabled();
  });

  it("papel_sem_work names who only has read access", async () => {
    serve();
    post.mockRejectedValue(
      apiReject(400, "papel_sem_work: authorUserId, mergerUserId só tem leitura neste card"),
    );
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("quem corrige");
    expect(alert).toHaveTextContent("responsável pelo merge");
    expect(alert).toHaveTextContent(/só tem leitura/i);
  });

  it("a 403 says only whoever works the card can ask for a review", async () => {
    serve();
    post.mockRejectedValue(apiReject(403, "forbidden"));
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/Só quem trabalha neste card/);
  });

  it("a message it does not know is shown as it came, not swallowed", async () => {
    serve();
    post.mockRejectedValue(apiReject(500, "disk exploded"));
    open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(startButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("disk exploded");
  });

  it("changing a pick clears the server's refusal", async () => {
    serve();
    post.mockRejectedValue(apiReject(400, "revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub"));
    open({ actorUserId: "u2" });
    await loaded();
    await userEvent.click(startButton());
    await screen.findByRole("alert");

    await userEvent.selectOptions(select(/^Responsável pelo merge/), "u2");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("reabrir a janela", () => {
    /** A janela como o bloco a usa: aberta e fechada de fora, a mesma instância. */
    function Harness({ onClose }: { onClose?: () => void }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>reabrir</button>
          <RequestReviewDialog cardId="c1" pr={PR} actorUserId="u2" open={open} onClose={() => { setOpen(false); onClose?.(); }} />
        </>
      );
    }

    it("uma recusa antiga nunca aparece na reabertura", async () => {
      serve();
      post.mockRejectedValue(apiReject(400, "revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub"));
      renderApp(<Harness />);
      await loaded();
      await userEvent.click(startButton());
      await screen.findByRole("alert");

      await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      await userEvent.click(screen.getByRole("button", { name: "reabrir" }));

      await loaded();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(startButton()).toBeEnabled();
    });

    it("a recusa que chega com a janela fechada (POST em voo) também não aparece na reabertura", async () => {
      serve();
      let refuse: (e: unknown) => void = () => {};
      post.mockReturnValue(new Promise((_resolve, reject) => { refuse = reject; }));
      renderApp(<Harness />);
      await loaded();
      await userEvent.click(startButton());
      await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));

      // o servidor responde DEPOIS de a janela fechar
      await act(async () => {
        refuse(apiReject(400, "revisor_sem_conta: o revisor não tem uma conta Claude própria no vibehub"));
      });
      await userEvent.click(screen.getByRole("button", { name: "reabrir" }));

      await loaded();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(startButton()).toBeEnabled();
    });

    it("o que foi escolhido na vez anterior não volta: cada abertura parte dos padrões", async () => {
      serve();
      renderApp(<Harness />);
      await loaded();
      await userEvent.selectOptions(select(/^Co-autor/), "u3");
      expect(select(/^Co-autor/).value).toBe("u3");

      await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      await userEvent.click(screen.getByRole("button", { name: "reabrir" }));

      await loaded();
      expect(select(/^Co-autor/).value).toBe("");
    });
  });

  it("Cancelar closes without sending anything", async () => {
    serve();
    const { onClose } = open({ actorUserId: "u2" });
    await loaded();

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("says so when the people could not be loaded, and offers no way to start", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === "/auth/me") return { user: MUSSA };
      if (url === "/setup/state") return setupState();
      throw apiReject(500, "boom");
    });
    open({ actorUserId: "u2" });

    expect(await screen.findByText(/Não deu pra carregar as pessoas/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Iniciar revisão" })).toBeNull();
  });
});

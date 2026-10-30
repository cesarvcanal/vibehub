import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewPanelView, type ReviewPanelViewProps } from "@/features/board/components/ReviewPanelView";
import type { Finding, Review, ReviewEvent, ReviewWorking } from "@/api/types";
import type { ReviewActions } from "@/features/board/lib/review";

/**
 * The PR review's panel in every state it can be in, from fixtures — and one story ("Ao vivo") that
 * plays a whole review through, the way the panel moves when the server answers each 3 s.
 */

const MIN = 60_000;
const T0 = Date.now() - 90 * MIN;
const at = (minutes: number) => T0 + minutes * MIN;

const PEOPLE: Record<string, string> = { "u-albert": "albert", "u-mussa": "mussa" };
const nameOf = (id: string | undefined) => (id ? PEOPLE[id] ?? id : "—");

const NOBODY: ReviewWorking = { author: false, reviewer: false };
const NO_ACTIONS: ReviewActions = { decide: false, retry: false, cancel: false, merge: false };

const f = (o: Partial<Finding> & Pick<Finding, "id" | "title">): Finding => ({
  severity: "suggestion", status: "open", introducedInRound: 1, ...o,
});

/** The closed list of the round-1 review of PR #211 (the composer's upload rework). */
const FINDINGS: Finding[] = [
  f({
    id: "f1", severity: "blocking", title: "Chips em erro nunca saem do stash e reenviam a cada F5",
    file: "front/src/features/board/components/TerminalComposer.tsx", line: 514,
    proof: { kind: "scenario", ref: "TerminalComposer.tsx:514", detail: "upload falha, F5, o chip volta e reenvia" },
  }),
  f({
    id: "f2", severity: "blocking", title: "Stash em sessionStorage (chave única, ~5M chars) não comporta prints grandes",
    file: "front/src/features/board/components/TerminalComposer.tsx", line: 427,
    proof: { kind: "failing_test", ref: "TerminalComposer.test.tsx:88" },
  }),
  f({ id: "f3", title: "<img> do runner sem onError: 404 mostra ícone quebrado", file: "front/src/features/board/components/TerminalComposer.tsx", line: 1679 }),
  f({ id: "f4", title: "Remount com upload retomado em voo reenvia o mesmo arquivo" }),
  f({ id: "f5", title: "Nome do helper `pump` não diz o que faz" }),
  f({ id: "f6", severity: "question", title: "Trocar de card no meio do upload deveria cancelar o envio?" }),
];

const line = (o: Omit<ReviewEvent, "at"> & { min: number }): ReviewEvent => {
  const { min, ...rest } = o;
  return { at: at(min), ...rest };
};

const ROUND1: ReviewEvent[] = [
  line({ min: 0, round: 1, who: "system", text: "Revisão iniciada: o revisor confere o PR #211 (rodada 1 de 3)." }),
  line({
    min: 12, round: 1, who: "reviewer",
    text: "Dois bloqueantes no stash do composer: chip em erro que volta a cada F5 e o limite do sessionStorage. Quatro sugestões e uma dúvida pro humano.",
    items: [
      { id: "f1", status: "open", isNew: true }, { id: "f2", status: "open", isNew: true }, { id: "f3", status: "open", isNew: true },
      { id: "f4", status: "open", isNew: true }, { id: "f5", status: "open", isNew: true }, { id: "f6", status: "open", isNew: true },
    ],
  }),
  line({ min: 12, round: 1, who: "system", text: "2 bloqueante(s) em aberto: a lista vai ao autor. 1 dúvida(s) esperam o revisor humano." }),
  line({ min: 15, round: 1, who: "human", by: "albert", text: "Decisão humana em f6: retira.", items: [{ id: "f6", status: "dropped" }] }),
  line({
    min: 31, round: 1, who: "author", text: "2 corrigido(s), 0 contestado(s); head 9c1e2a4.",
    items: [
      { id: "f1", status: "fixed", commit: "9c1e2a4", reply: "Chip em erro sai do stash na hora; teste novo cobre o F5." },
      { id: "f2", status: "fixed", commit: "9c1e2a4", reply: "Arquivos ficam no store do módulo; o sessionStorage guarda só os ids." },
    ],
  }),
  line({ min: 31, round: 2, who: "system", text: "Rodada 2 de 3: o revisor confere só o diff." }),
];

const ROUND2: ReviewEvent[] = [
  line({
    min: 44, round: 2, who: "reviewer", text: "Os dois bloqueantes foram corrigidos de verdade; conferi no diff e os testes passam.",
    items: [
      { id: "f1", status: "fixed", reply: "Conferido: o chip em erro some do stash." },
      { id: "f2", status: "fixed", reply: "Conferido: só ids no sessionStorage." },
    ],
  }),
  line({ min: 44, round: 2, who: "system", text: "Sem bloqueante em aberto: pronto para o merge humano." }),
];

const fixed = (ids: string[], list: Finding[]) =>
  list.map((x) => (ids.includes(x.id) ? { ...x, status: "fixed" as const, commit: "9c1e2a4" } : x));

function review(o: Partial<Review> = {}): Review {
  return {
    id: "r1", prNumber: 211, phase: "reviewing", round: 1, cardId: "c1", projectId: "p1",
    prUrl: "https://github.com/cesarvcanal/vibehub/pull/211", prBranch: "card/ajuste-layout-240c", base: "main",
    reviewerUserId: "u-albert", authorUserId: "u-mussa", coauthorUserId: "u-albert", mergerUserId: "u-mussa",
    reviewerCardId: "rc1", findings: [], log: [], createdAt: T0, updatedAt: T0, ...o,
  };
}

const READY = review({
  phase: "ready", round: 2, lastSubmitRound: 2, reviewedSha: "a".repeat(40),
  findings: fixed(["f1", "f2"], FINDINGS).map((x) => (x.id === "f6" ? { ...x, status: "dropped" as const, humanDecision: "drop" as const } : x)),
  log: [...ROUND1, ...ROUND2],
});

const base: ReviewPanelViewProps = {
  review: review({ log: ROUND1.slice(0, 1) }),
  working: NOBODY,
  nameOf,
  actions: NO_ACTIONS,
  busy: false,
  mergeBusy: false,
  notice: null,
  onMerge: () => {},
  onRetry: () => {},
  onCancel: () => {},
  onDecide: () => {},
  onClose: () => {},
};

const meta = {
  title: "Revisão de PR/Painel",
  component: ReviewPanelView,
  args: base,
  // The panel is the column at the right of the card: its real width and the height of a screen.
  decorators: [(Story) => <div className="flex h-[820px] w-[460px]"><Story /></div>],
} satisfies Meta<typeof ReviewPanelView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RevisorLendo: Story = {
  name: "1. Revisor lendo o PR (rodada 1)",
  args: { working: { author: false, reviewer: true } },
};

export const DuvidaEsperandoDecisao: Story = {
  name: "2. Dúvida esperando a decisão do revisor humano",
  args: {
    review: review({ phase: "reviewing", round: 1, lastSubmitRound: 1, findings: FINDINGS, log: ROUND1.slice(0, 3) }),
    actions: { ...NO_ACTIONS, decide: true, cancel: true },
  },
};

export const AutorCorrigindo: Story = {
  name: "3. Autor corrigindo a lista",
  args: {
    review: review({
      phase: "fixing", round: 1, lastSubmitRound: 1,
      findings: FINDINGS.map((x) => (x.id === "f6" ? { ...x, status: "dropped" as const, humanDecision: "drop" as const } : x)),
      log: ROUND1.slice(0, 4),
    }),
    working: { author: true, reviewer: false },
  },
};

export const RevisorConferindoRodada2: Story = {
  name: "4. Revisor conferindo o que mudou (rodada 2)",
  args: {
    review: review({ phase: "reviewing", round: 2, lastSubmitRound: 1, findings: READY.findings, log: ROUND1 }),
    working: { author: false, reviewer: true },
  },
};

export const ProntoPraMerge: Story = {
  name: "5. Pronto pra merge (visto por quem mergeia)",
  args: { review: READY, actions: { ...NO_ACTIONS, merge: true, cancel: true } },
};

export const IaMexendoDepoisDoPronto: Story = {
  name: "6. Pronto, mas a IA do autor está mexendo no PR",
  args: { review: READY, working: { author: true, reviewer: false }, actions: { ...NO_ACTIONS, merge: true, cancel: true } },
};

const REOPENED_LOG = [
  ...READY.log,
  line({
    min: 70, round: 3, who: "system",
    text: "O autor empurrou depois do pronto (head 4f7d0b2): push depois do pronto; o PR não está mais no commit aprovado (aaaaaaa). Rodada 3 de 3: o revisor confere o que entrou.",
  }),
];

export const PrContinuou: Story = {
  name: "7. O PR continuou: a revisão voltou pro revisor",
  args: {
    review: { ...READY, phase: "reviewing", round: 3, lastSubmitRound: 2, prHeadSha: "4f7d0b2".padEnd(40, "0"), log: REOPENED_LOG },
    working: { author: false, reviewer: true },
  },
};

export const SugestoesAplicadas: Story = {
  name: "8. Sugestões aplicadas e conferidas",
  args: {
    review: {
      ...READY, round: 3, lastSubmitRound: 3,
      findings: fixed(["f1", "f2", "f3", "f4"], READY.findings).map((x) =>
        x.id === "f5" ? { ...x, status: "wontfix" as const, authorReply: "o nome segue o padrão do arquivo" } : x),
      log: [
        ...REOPENED_LOG,
        line({
          min: 78, round: 3, who: "author", text: "Sugestões respondidas: 2 corrigido(s), 0 contestado(s), 1 não vai(ão) aplicar; head 4f7d0b2.",
          items: [
            { id: "f3", status: "fixed", commit: "4f7d0b2", reply: "Fallback pro nome do arquivo." },
            { id: "f4", status: "fixed", commit: "4f7d0b2", reply: "Reaproveita o upload em voo." },
            { id: "f5", status: "wontfix", reply: "O nome segue o padrão do arquivo." },
          ],
        }),
        line({
          min: 82, round: 3, who: "reviewer", text: "Conferi: duas sugestões aplicadas de verdade; a terceira fica como está.",
          items: [
            { id: "f3", status: "fixed", reply: "onError cai no nome do arquivo." },
            { id: "f4", status: "fixed", reply: "Upload em voo é reaproveitado no remount." },
          ],
        }),
        line({ min: 82, round: 3, who: "system", text: "Sem bloqueante em aberto: pronto para o merge humano." }),
      ],
    },
    actions: { ...NO_ACTIONS, merge: true, cancel: true },
  },
};

export const Impasse: Story = {
  name: "9. Impasse (3 rodadas com item travado)",
  args: {
    review: review({
      phase: "impasse", round: 3, lastSubmitRound: 3, impasseReason: "rodadas",
      findings: FINDINGS.map((x) => (x.id === "f2" ? { ...x, status: "contested" as const, authorReply: "o limite é do navegador, não do código" } : x)),
      log: ROUND1,
    }),
    actions: { decide: true, retry: false, cancel: true, merge: false },
  },
};

export const Mergeado: Story = {
  name: "10. Mergeado",
  args: {
    review: {
      ...READY, phase: "merged",
      log: [...READY.log, line({ min: 88, round: 2, who: "human", by: "mussa", text: "Mergeado em main por mussa (head aaaaaaa)." })],
    },
  },
};

/**
 * A whole review played through: each step is what a 3 s read of the server would bring — the
 * reviewer typing, its round landing, the author typing, the push after ready, the reviewer
 * checking the suggestions. Loops.
 */
const TIMELINE: { review: Review; working: ReviewWorking }[] = [
  { review: review({ log: ROUND1.slice(0, 1) }), working: { author: false, reviewer: true } },
  { review: review({ phase: "reviewing", lastSubmitRound: 1, findings: FINDINGS, log: ROUND1.slice(0, 3) }), working: NOBODY },
  { review: review({ phase: "fixing", lastSubmitRound: 1, findings: FINDINGS, log: ROUND1.slice(0, 4) }), working: { author: true, reviewer: false } },
  { review: review({ phase: "reviewing", round: 2, lastSubmitRound: 1, findings: READY.findings, log: ROUND1 }), working: { author: false, reviewer: true } },
  { review: READY, working: NOBODY },
  { review: READY, working: { author: true, reviewer: false } },
  { review: { ...READY, phase: "reviewing", round: 3, lastSubmitRound: 2, log: REOPENED_LOG }, working: { author: false, reviewer: true } },
  {
    review: SugestoesAplicadas.args!.review!,
    working: NOBODY,
  },
];

function LivePanel(props: ReviewPanelViewProps) {
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setStep((s) => (s + 1) % TIMELINE.length), 3_000);
    return () => window.clearInterval(timer);
  }, []);
  const now = TIMELINE[step]!;
  return <ReviewPanelView {...props} review={now.review} working={now.working} actions={{ ...NO_ACTIONS, merge: true, cancel: true }} />;
}

export const AoVivo: Story = {
  name: "0. Ao vivo (a revisão inteira, um passo a cada 3 s)",
  render: (args) => <LivePanel {...args} />,
};

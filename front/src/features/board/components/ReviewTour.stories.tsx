import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrReviewBlock } from "@/features/board/components/PrReviewBlock";
import { ReviewPanelView, type ReviewPanelViewProps } from "@/features/board/components/ReviewPanelView";
import * as Panel from "@/features/board/components/ReviewPanelView.stories";
import type { CardPr } from "@/api/types";

/**
 * TOUR — the PR review as it is now, one page: the real components (the same ones the app renders),
 * with the same fixtures as the panel's stories, each next to a caption saying what changed and why.
 * For a person to check the work without setting up a review with two AIs.
 */

const base = Panel.default.args as ReviewPanelViewProps;
const props = (story: { args?: Partial<ReviewPanelViewProps> }, extra: Partial<ReviewPanelViewProps> = {}): ReviewPanelViewProps => ({
  ...base, ...story.args, ...extra,
});

const PR: CardPr = {
  number: 211, url: "https://github.com/cesarvcanal/vibehub/pull/211", base: "main", branch: "card/ajuste-layout-240c", openedAt: 1,
};

function Section({ n, title, children, caption }: { n: number; title: string; caption: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border/60 pt-6">
      <div className="max-w-3xl space-y-1">
        <h2 className="text-base font-semibold">
          <span className="mr-2 text-amber-400">{n}.</span>
          {title}
        </h2>
        <div className="space-y-1 text-sm text-muted-foreground">{caption}</div>
      </div>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </section>
  );
}

/** A panel at the size it has in the app: the column at the right of the card. */
function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="space-y-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      <div className="flex h-[760px] w-[440px]">{children}</div>
    </figure>
  );
}

function Tour() {
  return (
    <div className="mx-auto max-w-[1500px] space-y-8 pb-16">
      <header className="max-w-3xl space-y-2">
        <h1 className="text-xl font-semibold">Revisão de PR — como ficou</h1>
        <p className="text-sm text-muted-foreground">
          Tudo abaixo são os componentes de verdade do PR #213, com dados de exemplo (o PR #211 do card ajuste-layout). O
          painel é a coluna à direita do card; o bloco do PR fica acima do composer; a mesma pill aparece na linha da barra
          lateral.
        </p>
      </header>

      <Section
        n={0}
        title="Ao vivo: a revisão inteira andando sozinha"
        caption={
          <p>
            Um passo a cada 3 segundos, como o painel se move quando o servidor responde: o revisor “digitando”, a rodada
            dele chegando, o autor corrigindo, a revisão pronta, a IA mexendo depois do pronto, o PR voltando ao revisor e as
            sugestões conferidas. Nada é recarregado: é a mesma leitura ao vivo do app.
          </p>
        }
      >
        <Frame label="O painel, sozinho (repete em loop)">{Panel.AoVivo.render!(base, {} as never)}</Frame>
      </Section>

      <Section
        n={1}
        title="Dúvida esperando decisão — antes ninguém sabia"
        caption={
          <>
            <p>
              Antes: só a pill “aguardando decisão” e dois botões secos (Bloquear, Descartar). O aviso ia pro card escondido
              do revisor, e ninguém via.
            </p>
            <p>
              Agora: aviso no topo dizendo quem precisa decidir e que a revisão está parada; “Decidir agora” leva à escolha;
              três opções explicadas, escolhe e confirma. Quem não decide vê por quem a revisão espera. O aviso também chega
              no card do autor.
            </p>
          </>
        }
      >
        <Frame label="Quem decide (o revisor humano, ou um owner)">
          <ReviewPanelView {...props(Panel.DuvidaEsperandoDecisao)} />
        </Frame>
        <Frame label="Os outros (autor, quem mergeia): sabem por quem espera">
          <ReviewPanelView {...props(Panel.DuvidaEsperandoDecisao, { actions: { ...base.actions, cancel: true } })} initialTab="findings" />
        </Frame>
      </Section>

      <Section
        n={2}
        title="Sugestões: marcar e pedir ao autor"
        caption={
          <p>
            Antes: sugestões “aberto” pra sempre, sem ação. Agora: marque as que valem a pena e clique em “Pedir ao autor
            aplicar (N)”. A IA do autor aplica, empurra e responde cada uma (feita, ou por que não — “não vai aplicar”); o
            revisor confere e o status muda aqui.
          </p>
        }
      >
        <Frame label="Pronto pra merge, aba Achados (quem mergeia)">
          <ReviewPanelView {...props(Panel.ProntoPraMerge)} initialTab="findings" />
        </Frame>
        <Frame label="Depois: sugestões aplicadas e conferidas (e uma que não vai aplicar)">
          <ReviewPanelView {...props(Panel.SugestoesAplicadas)} initialTab="findings" />
        </Frame>
      </Section>

      <Section
        n={3}
        title="Status ao vivo: a IA mexendo num PR pronto"
        caption={
          <p>
            Antes: “pronto pra merge” enquanto a IA do autor mudava o código. Agora: a pill vira “IA mexendo” (painel, bloco
            do card e barra lateral), o merge espera ela terminar, e a conversa mostra “mussa está mexendo no PR” com os
            pontinhos. Se ela empurrar commit, a revisão volta sozinha ao revisor.
          </p>
        }
      >
        <Frame label="Painel com a IA do autor trabalhando">
          <ReviewPanelView {...props(Panel.IaMexendoDepoisDoPronto)} />
        </Frame>
        <Frame label="O PR continuou: o revisor confere o que entrou">
          <ReviewPanelView {...props(Panel.PrContinuou)} />
        </Frame>
      </Section>

      <Section
        n={4}
        title="O bloco do PR acima do composer, em cada estado"
        caption={<p>Lê a revisão ao vivo (a mesma leitura do painel): muda sozinho, sem recarregar a tela. Mergeado, o bloco sai da tela.</p>}
      >
        <div className="w-[760px] space-y-2">
          <PrReviewBlock cardId="c1" pr={PR} onOpenPanel={() => {}} />
          <PrReviewBlock cardId="c1" pr={PR} review={{ id: "r1", prNumber: 211, phase: "reviewing", round: 1 }} onOpenPanel={() => {}} />
          <PrReviewBlock cardId="c1" pr={PR} review={{ id: "r1", prNumber: 211, phase: "reviewing", round: 1, pendingQuestions: 2 }} onOpenPanel={() => {}} />
          <PrReviewBlock cardId="c1" pr={PR} review={{ id: "r1", prNumber: 211, phase: "ready", round: 1 }} onOpenPanel={() => {}} />
          <PrReviewBlock cardId="c1" pr={PR} review={{ id: "r1", prNumber: 211, phase: "ready", round: 1 }} authorWorking onOpenPanel={() => {}} />
        </div>
      </Section>

      <Section
        n={5}
        title="A conversa das IAs, como um chat"
        caption={
          <p>
            Revisor à esquerda, autor à direita, cada fala com os achados e a resposta daquela rodada; divisória por rodada;
            o sistema e as pessoas no meio. Rola sozinha quando você está no fim. A story “0. Ao vivo” (no menu à esquerda)
            percorre a revisão inteira, um passo a cada 3 segundos.
          </p>
        }
      >
        <Frame label="Revisor conferindo a rodada 2">
          <ReviewPanelView {...props(Panel.RevisorConferindoRodada2)} />
        </Frame>
        <Frame label="Impasse: o que está travado e quem decide">
          <ReviewPanelView {...props(Panel.Impasse)} initialTab="findings" />
        </Frame>
      </Section>
    </div>
  );
}

const meta = {
  title: "Revisão de PR/Tour — como ficou",
  component: Tour,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Tour>;
export default meta;

export const ComoFicou: StoryObj<typeof meta> = { name: "Como ficou (página única)" };

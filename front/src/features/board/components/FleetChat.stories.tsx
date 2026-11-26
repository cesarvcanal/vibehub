import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReviewFleetAgent, ReviewFleetRun } from "@/api/types";
import { FleetChat } from "@/features/board/components/FleetChat";
import { reviewFleetChat } from "@/features/board/lib/fleetChat";

const T0 = Date.UTC(2026, 10, 20, 1, 41);
const minute = (n: number) => T0 + n * 60_000;

const contextSummary = [
  "PR #337 (head `0ab7e421`), só front:",
  "",
  "1. `pillPercent` (usage.ts:113) mostra só a sessão de 5h, com a chave nova `plan.sessionShort`. Sem `fiveHour` devolve null; antes caía no semanal.",
  "2. Saem `ContextNotice` e as chaves `context.notice.*`.",
  "3. Hook novo `front/src/lib/useTweenedNumber.ts` (rAF, 700ms, respeita reduced-motion) anima o medidor.",
  "4. O badge (CardTerminalView.tsx:1019) trunca o nome do plano.",
  "5. Testes do medidor reescritos com `vi.useFakeTimers`.",
  "",
  "Pontos para a frota olhar: o custo do hook a cada frame, os testes de tempo e o contrato do `pillPercent`.",
].join("\n");

const longEvidence = [
  "Li `front/src/lib/useTweenedNumber.ts` no head 0ab7e421. A linha 32 é `return prefersReducedMotion() ? target : shown;`, e a linha 3 define `prefersReducedMotion` como `window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches`.",
  "",
  "A chamada corre no corpo do hook, então roda a cada render do consumidor. Durante o tween, `step` (linhas 21-27) faz `setShown(value)` a cada frame: são ~42 chamadas de `matchMedia` em 700ms por medidor na tela.",
  "",
  "- ContextMeter.tsx:41 chama o hook antes do `return null` da linha 42;",
  "- SdkChatView.tsx:1483 monta dois medidores ao mesmo tempo.",
].join("\n");

const agent = (over: Partial<ReviewFleetAgent> & Pick<ReviewFleetAgent, "id" | "label">): ReviewFleetAgent => ({ phase: "", status: "done", ...over });

const busyFleet: ReviewFleetRun = {
  runId: "wf_story", name: "vibehub-pr-analysis", phases: ["Contexto", "Revisão", "Consolidação", "Verificação"], total: 10, done: 7, at: minute(9), finished: false,
  agents: [
    agent({ id: "a1", label: "contexto", model: "claude-opus-5-5", modelLabel: "Opus 5.5", endedAt: minute(0), result: JSON.stringify({ summary: contextSummary }) }),
    agent({ id: "a2", label: "revisão:performance", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", endedAt: minute(2), result: JSON.stringify({ findings: [{ title: "useTweenedNumber chama matchMedia a cada frame da animação" }] }) }),
    agent({ id: "a3", label: "revisão:contracts", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", endedAt: minute(3), result: JSON.stringify({ findings: [{ title: "Testes do medidor esperam 700ms no relógio real" }, { title: "pillPercent devolve null sem fiveHour" }] }) }),
    agent({ id: "a4", label: "revisão:security", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", endedAt: minute(3), result: JSON.stringify({ findings: [] }) }),
    agent({
      id: "a10", label: "consolidação", model: "claude-opus-5-5", modelLabel: "Opus 5.5", endedAt: minute(4),
      result: JSON.stringify({ findings: [
        { title: "useTweenedNumber chama matchMedia a cada frame da animação", members: ["c1"] },
        { title: "Testes do medidor esperam 700ms no relógio real", members: ["c2"] },
        { title: "pillPercent devolve null sem fiveHour", members: ["c3"] },
      ] }),
    }),
    agent({ id: "a5", label: "verificação:performance · useTweenedNumber chama matchMedia a cada frame da animação", model: "claude-haiku-4-5", modelLabel: "Haiku 4.5", endedAt: minute(5), result: JSON.stringify({ confirmed: true, evidence: longEvidence }) }),
    agent({ id: "a6", label: "verificação:contracts · Testes do medidor esperam 700ms no relógio real", model: "claude-haiku-4-5", modelLabel: "Haiku 4.5", endedAt: minute(6), result: JSON.stringify({ confirmed: false, evidence: "Os testes usam `vi.useFakeTimers` desde a linha 12 e avançam 700ms com `vi.advanceTimersByTime`." }) }),
    agent({ id: "a7", label: "revisão:tests", model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", status: "stopped" }),
    agent({ id: "a8", label: "verificação:contracts · pillPercent devolve null sem fiveHour", model: "claude-haiku-4-5", modelLabel: "Haiku 4.5", status: "running" }),
    agent({ id: "a9", label: "juiz", model: "claude-opus-5-5", modelLabel: "Opus 5.5", status: "running" }),
  ],
};

const meta: Meta<typeof FleetChat> = {
  title: "Board/FleetChat",
  component: FleetChat,
  decorators: [(Story) => <div className="w-[480px] rounded-xl border border-border bg-card p-3"><Story /></div>],
};
export default meta;

type Story = StoryObj<typeof FleetChat>;

export const FrotaConversando: Story = {
  args: { entries: reviewFleetChat(busyFleet), label: "Conversa dos agentes" },
};

export const FrotaTerminada: Story = {
  args: {
    entries: reviewFleetChat({
      ...busyFleet, finished: true,
      agents: [...busyFleet.agents.slice(0, 7), agent({ id: "a9", label: "juiz", model: "claude-opus-5-5", modelLabel: "Opus 5.5", endedAt: minute(12), result: "**Não apto**: 1 bloqueante confirmado (matchMedia a cada frame)." })],
    }),
    label: "Conversa dos agentes",
  },
};

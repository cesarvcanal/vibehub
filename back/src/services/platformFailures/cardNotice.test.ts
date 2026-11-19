import { describe, it, expect, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformFailure, PlatformFailureReport } from "./types.js";

async function fresh() {
  vi.resetModules();
  const dataDir = await mkdtemp(join(tmpdir(), "vibehub-card-notice-"));
  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dataDir;
  await (await import("../settings/settings.js")).updateSettings({ selfProjectId: "p-vibehub" });
  return { failures: await import("./platformFailures.js"), notices: await import("./cardNotice.js") };
}

const FAILURE: PlatformFailure = {
  id: "f-1",
  signature: "agent_report|usage-meter|x",
  source: "agent_report",
  status: "open",
  component: "usage-meter",
  symptom: "user_report: medidor mostra a conta antiga",
  evidence: "GET /api/usage respondeu 3%; a tela mostrava 57%",
  hypothesis: "cache do front",
  explanation: "O medidor de uso mostrou o consumo da conta Claude anterior.",
  originCardId: "card-1",
  occurrences: 2,
  affectedCardIds: ["card-1", "card-2"],
  firstSeenAt: 1_000,
  lastSeenAt: 2_000,
  investigationCardId: "fix-card",
};

function userReport(cardId: string): PlatformFailureReport {
  return { source: "agent_report", component: "usage-meter", symptom: "medidor velho", evidence: "tela 57%, rota 3%", explanation: "O medidor ficou na conta antiga.", cardId };
}

describe("aviso de falha para um card", () => {
  it("membro vê detalhes da falha que nasceu no card dele", async () => {
    const { notices } = await fresh();
    expect(notices.buildCardFailureNotice(FAILURE, "card-1", false)).toEqual({
      id: "f-1",
      source: "agent_report",
      status: "open",
      explanation: "O medidor de uso mostrou o consumo da conta Claude anterior.",
      occurrences: 2,
      firstSeenAt: 1_000,
      details: {
        symptom: "user_report: medidor mostra a conta antiga",
        component: "usage-meter",
        evidence: "GET /api/usage respondeu 3%; a tela mostrava 57%",
        hypothesis: "cache do front",
      },
    });
  });

  it("membro não vê detalhes de falha que nasceu em outro card", async () => {
    const { notices } = await fresh();
    const notice = notices.buildCardFailureNotice(FAILURE, "card-2", false);
    expect(notice).not.toHaveProperty("details");
    expect(notice).toMatchObject({ id: "f-1", explanation: FAILURE.explanation });
  });

  it("registro antigo sem card de origem não mostra detalhes ao membro", async () => {
    const { notices } = await fresh();
    const { originCardId: _origin, ...legacyFailure } = FAILURE;
    expect(notices.buildCardFailureNotice(legacyFailure, "card-1", false)).not.toHaveProperty("details");
  });

  it("dono vê detalhes sempre", async () => {
    const { notices } = await fresh();
    expect(notices.buildCardFailureNotice(FAILURE, "card-2", true).details).toMatchObject({ evidence: FAILURE.evidence });
  });

  it("o aviso nunca leva os outros cards afetados nem o card da investigação", async () => {
    const { notices } = await fresh();
    const notice = notices.buildCardFailureNotice(FAILURE, "card-1", true);
    expect(notice).not.toHaveProperty("affectedCardIds");
    expect(notice).not.toHaveProperty("investigationCardId");
  });

  it("o stream manda as falhas ativas do card, depois as mudanças, e para ao fechar", async () => {
    const { failures, notices } = await fresh();
    const existing = await failures.recordPlatformFailure(userReport("card-1"));
    const frames: { type: string; notices?: { id: string }[]; notice?: { id: string; status: string } }[] = [];
    const stopStream = notices.streamCardFailureNotices("card-1", false, (frame) => frames.push(frame));
    await vi.waitFor(() => expect(frames).toEqual([{ type: "platform_failures", notices: [expect.objectContaining({ id: existing!.id })] }]));
    await failures.dismissPlatformFailure(existing!.id);
    expect(frames.at(-1)).toEqual({ type: "platform_failure", notice: expect.objectContaining({ id: existing!.id, status: "dismissed" }) });
    stopStream();
    await failures.recordPlatformFailure({ ...userReport("card-1"), component: "other" });
    expect(frames).toHaveLength(2);
  });

  it("o stream não manda falha de outro card", async () => {
    const { failures, notices } = await fresh();
    const frames: object[] = [];
    onTestFinished(notices.streamCardFailureNotices("card-1", true, (frame) => frames.push(frame)));
    await vi.waitFor(() => expect(frames).toEqual([{ type: "platform_failures", notices: [] }]));
    await failures.recordPlatformFailure(userReport("card-2"));
    expect(frames).toHaveLength(1);
  });

  it("o fim da falha chega ao card aberto que já saiu da lista de afetados", async () => {
    const { failures, notices } = await fresh();
    const recorded = await failures.recordPlatformFailure(userReport("card-0"));
    const frames: { type: string; notice?: { id: string; status: string } }[] = [];
    onTestFinished(notices.streamCardFailureNotices("card-0", false, (frame) => frames.push(frame)));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    for (const index of Array.from({ length: 20 }, (_unused, position) => position + 1)) {
      await failures.recordPlatformFailure(userReport(`card-${index}`));
    }
    expect((await failures.getPlatformFailure(recorded!.id)).affectedCardIds).not.toContain("card-0");
    await failures.dismissPlatformFailure(recorded!.id);
    expect(frames.at(-1)).toEqual({ type: "platform_failure", notice: expect.objectContaining({ id: recorded!.id, status: "dismissed" }) });
    expect(frames).toHaveLength(2);
  });

  it("mudança de falha que nunca afetou o card não chega a ele", async () => {
    const { failures, notices } = await fresh();
    const recorded = await failures.recordPlatformFailure(userReport("card-1"));
    const frames: object[] = [];
    onTestFinished(notices.streamCardFailureNotices("card-other", true, (frame) => frames.push(frame)));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await failures.dismissPlatformFailure(recorded!.id);
    await failures.recordPlatformFailure({ ...userReport("card-2"), component: "other" });
    expect(frames).toHaveLength(1);
  });

  it("a falha que alcança o card com ele aberto chega como aviso novo", async () => {
    const { failures, notices } = await fresh();
    await failures.recordPlatformFailure(userReport("card-1"));
    const frames: { type: string; notice?: { id: string; occurrences: number } }[] = [];
    onTestFinished(notices.streamCardFailureNotices("card-2", false, (frame) => frames.push(frame)));
    await vi.waitFor(() => expect(frames).toEqual([{ type: "platform_failures", notices: [] }]));
    await failures.recordPlatformFailure(userReport("card-2"));
    expect(frames.at(-1)).toEqual({ type: "platform_failure", notice: expect.objectContaining({ occurrences: 2 }) });
    expect(frames.at(-1)!.notice).not.toHaveProperty("details");
  });
});

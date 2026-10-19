import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { boardApi, type CardUsageResponse } from "@/features/board/api";
import { PlanUsageMeter } from "@/features/board/components/PlanUsage";
import { renderApp } from "@/test/render";

/**
 * O MEDIDOR DO TOPO: o número é o do limite SEMANAL (é por ele que o dono acompanha a semana), a
 * cor esquenta com ele, e sem leitura ele diz isso — com o comando só para quem tem o shell.
 */
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

function serve(body: CardUsageResponse) {
  vi.spyOn(boardApi, "cardUsage").mockResolvedValue(body);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlanUsageMeter", () => {
  it("shows the WEEKLY number even when the session is fuller", async () => {
    serve({
      slug: "albert",
      usage: { available: true, fiveHour: { utilization: 92, resetsAt: iso(3_600_000) }, sevenDay: { utilization: 36, resetsAt: iso(86_400_000) }, fetchedAt: Date.now() },
    });
    renderApp(<PlanUsageMeter cardId="c1" accountName="albert" active isOwner />);
    await waitFor(() => expect(screen.getByTestId("plan-meter-value")).toHaveTextContent("36%"));
    expect(screen.getByTestId("plan-meter")).toHaveAccessibleName("Weekly limit: 36%");
  });

  it("warms the pill once the week passes 60%", async () => {
    serve({ slug: "albert", usage: { available: true, sevenDay: { utilization: 88, resetsAt: iso(86_400_000) }, fetchedAt: Date.now() } });
    renderApp(<PlanUsageMeter cardId="c1" accountName="albert" active isOwner />);
    const meter = await screen.findByTestId("plan-meter");
    await waitFor(() => expect(meter.getAttribute("data-tone")).toBe("orange"));
    expect(meter.style.borderColor).not.toBe("");
  });

  it("without a reading: no stray dot, 'no reading', and the command only for the owner", async () => {
    serve({ slug: "default", usage: { available: false, error: "no_credentials", fetchedAt: Date.now() } });
    const user = userEvent.setup();
    renderApp(<PlanUsageMeter cardId="c1" accountName="cesar" active isOwner={false} />);
    const meter = await screen.findByTestId("plan-meter");
    await waitFor(() => expect(meter).toHaveTextContent("no reading"));
    expect(screen.queryByTestId("plan-ring-arc")).toBeNull();

    await user.click(meter);
    const panel = await screen.findByTestId("plan-panel");
    expect(within(panel).getByTestId("plan-no-reading")).toHaveTextContent("Ask the panel owner");
    expect(within(panel).queryByText(/CLAUDE_CONFIG_DIR/)).toBeNull();
  });

  it("the owner gets the command that fixes it", async () => {
    serve({ slug: "default", usage: { available: false, error: "no_credentials", fetchedAt: Date.now() } });
    const user = userEvent.setup();
    renderApp(<PlanUsageMeter cardId="c1" accountName="cesar" active isOwner />);
    const meter = await screen.findByTestId("plan-meter");
    await waitFor(() => expect(meter).toHaveTextContent("no reading"));
    await user.click(meter);
    expect(within(await screen.findByTestId("plan-panel")).getByTestId("plan-no-reading")).toHaveTextContent("/root/.claude");
  });
});

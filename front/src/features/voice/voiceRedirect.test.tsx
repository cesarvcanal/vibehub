import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { VoiceRedirect } from "@/routes";

/** The old isolated /voice page is gone: a legacy link lands in the card's chat, where the call lives. */

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function at(url: string) {
  render(
    <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/voice" element={<VoiceRedirect />} />
        <Route path="/" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId("where").textContent;
}

describe("/voice (legacy link)", () => {
  it("leads to the card it named, keeping its project", () => {
    expect(at("/voice?project=p1&card=c1")).toBe("/?project=p1&card=c1");
  });
  it("without a card, leads to the board — never to an isolated voice page", () => {
    expect(at("/voice")).toBe("/");
    expect(screen.queryByTestId("voice-orb")).toBeNull();
  });
});

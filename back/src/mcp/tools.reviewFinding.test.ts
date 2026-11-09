import { describe, expect, it } from "vitest";
import { reviewFinding } from "./tools.js";

describe("reviewFinding — o achado chega explicado ou é recusado na porta da IA", () => {
  const base = { title: "cache sem teto", problem: "O mapa cresce sem limite.", fix: "Use um LRU." };

  it("sugestão e bloqueante sem 'fix', ou qualquer achado sem 'problem', são recusados", () => {
    expect(reviewFinding.safeParse({ ...base, severity: "suggestion", fix: undefined }).success).toBe(false);
    expect(reviewFinding.safeParse({ ...base, severity: "blocking", fix: "  " }).success).toBe(false);
    expect(reviewFinding.safeParse({ ...base, severity: "question", problem: undefined }).success).toBe(false);
  });

  it("dúvida sem 'fix' e achado derrubado só com título passam", () => {
    expect(reviewFinding.safeParse({ ...base, severity: "question", fix: undefined }).success).toBe(true);
    expect(reviewFinding.safeParse({ severity: "refuted", title: "x" }).success).toBe(true);
    expect(reviewFinding.safeParse({ ...base, severity: "suggestion" }).success).toBe(true);
  });
});

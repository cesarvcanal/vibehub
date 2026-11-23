import { describe, expect, it } from "vitest";
import type { SdkRow } from "@/features/board/lib/sdkChat";
import { findDispatchingSkill } from "./dispatchingSkill";

const userRow = (id: string): SdkRow => ({ kind: "user", id, text: "revisa", state: "sent" });
const skillRow = (id: string, skill: string, parent?: string): SdkRow => ({
  kind: "tool", id, name: "Skill", summary: skill, input: { skill }, ...(parent ? { parent } : {}),
});
const agentRow = (id: string, parent?: string): SdkRow => ({
  kind: "tool", id, name: "Agent", summary: "Code review · padrões",
  input: { description: "Code review · padrões", subagent_type: "general-purpose" }, ...(parent ? { parent } : {}),
});
const readRow = (id: string): SdkRow => ({ kind: "tool", id, name: "Read", summary: "AGENTS.md", input: { file_path: "AGENTS.md" } });

describe("findDispatchingSkill", () => {
  it.each<[string, SdkRow[], string | undefined]>([
    ["a skill chamada antes do despacho, no mesmo turno, é a dona do subagente",
      [userRow("u1"), skillRow("s1", "mattpocock-skills:code-review"), readRow("r1"), agentRow("a1")], "mattpocock-skills:code-review"],
    ["com duas skills no turno, vale a mais próxima do despacho",
      [userRow("u1"), skillRow("s1", "superpowers:brainstorming"), skillRow("s2", "mattpocock-skills:code-review"), agentRow("a1")], "mattpocock-skills:code-review"],
    ["skill de um turno anterior não vale para o despacho de agora",
      [userRow("u1"), skillRow("s1", "mattpocock-skills:code-review"), userRow("u2"), agentRow("a1")], undefined],
    ["skill chamada depois do despacho não é dona dele",
      [userRow("u1"), agentRow("a1"), skillRow("s1", "mattpocock-skills:code-review")], undefined],
    ["skill chamada por outro subagente não é dona do despacho do agente principal",
      [userRow("u1"), agentRow("a0"), skillRow("s1", "mattpocock-skills:code-review", "a0"), agentRow("a1")], undefined],
    ["despacho sem skill no turno não tem dona",
      [userRow("u1"), readRow("r1"), agentRow("a1")], undefined],
  ])("%s", (_name, rows, expected) => {
    expect(findDispatchingSkill(rows, "a1")).toBe(expected);
  });

  it("subagente despachado por outro subagente acha a skill que esse outro chamou", () => {
    const rows = [userRow("u1"), agentRow("a0"), skillRow("s1", "mattpocock-skills:code-review", "a0"), agentRow("a1", "a0")];
    expect(findDispatchingSkill(rows, "a1")).toBe("mattpocock-skills:code-review");
  });

  it("despacho que não está nas linhas não tem dona", () => {
    expect(findDispatchingSkill([userRow("u1"), skillRow("s1", "mattpocock-skills:code-review")], "a1")).toBeUndefined();
  });
});

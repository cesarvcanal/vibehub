import { describe, expect, it } from "vitest";
import { readSkillName } from "./skillName";

describe("readSkillName", () => {
  it.each<[string, unknown, string | undefined]>([
    ["o campo skill é o nome da skill", { skill: "mattpocock-skills:code-review", args: "high" }, "mattpocock-skills:code-review"],
    ["sem skill, vale o campo name", { name: "code-review" }, "code-review"],
    ["sem skill nem name, vale o campo command", { command: "x" }, "x"],
    ["skill em branco cede a vez ao campo seguinte", { skill: "  ", command: "x" }, "x"],
    ["o nome sai sem os espaços das pontas", { skill: " code-review " }, "code-review"],
    ["campo que não é texto não vira nome", { skill: 42 }, undefined],
    ["input sem nenhum dos campos não tem nome", { args: "high" }, undefined],
    ["input que não é objeto não tem nome", "code-review", undefined],
    ["input ausente não tem nome", undefined, undefined],
  ])("%s", (_name, input, expected) => {
    expect(readSkillName(input)).toBe(expected);
  });
});

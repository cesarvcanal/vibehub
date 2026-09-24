import { describe, expect, it } from "vitest";
import {
  applySlashPick,
  filterSlashCommands,
  scoreSlashCommand,
  slashQuery,
  type SlashCommandInfo,
} from "./slashMenu";

/** A catalogue shaped like a real session's: skills first, then built-ins (the CLI's own order). */
const CATALOGUE: SlashCommandInfo[] = [
  { name: "code-review", description: "Review the current diff for correctness bugs", argumentHint: "[<pr#>]", aliases: ["review"], source: "skill" },
  { name: "simplify", description: "Review the changed code for reuse and simplification", source: "skill" },
  { name: "systematic-debugging", description: "Hunt a bug down by bisecting hypotheses", source: "skill" },
  { name: "superpowers:brainstorm", description: "Brainstorming with subagents", source: "plugin" },
  { name: "compact", description: "Compact the conversation", source: "command" },
  { name: "usage", description: "Show plan usage limits", source: "command" },
];

describe("slashQuery", () => {
  it("opens on a lone slash and tracks the name being typed", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/superpowers:brain")).toBe("superpowers:brain");
  });

  it("closes the moment the name is settled — what follows is arguments, not a search", () => {
    expect(slashQuery("/code-review ")).toBeNull();
    expect(slashQuery("/code-review high")).toBeNull();
  });

  it("ignores a slash that is not the start of the message", () => {
    expect(slashQuery("look at src/a.ts")).toBeNull();
    expect(slashQuery("what about /code-review")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("scoreSlashCommand", () => {
  const review = CATALOGUE[0]!;

  it("ranks an exact name above a prefix, a prefix above a substring", () => {
    expect(scoreSlashCommand(review, "code-review")).toBeGreaterThan(scoreSlashCommand(review, "code"));
    expect(scoreSlashCommand(review, "code")).toBeGreaterThan(scoreSlashCommand(review, "de-rev"));
  });

  it("matches an alias like a name — /review is /code-review", () => {
    expect(scoreSlashCommand(review, "review")).toBeGreaterThanOrEqual(80);
  });

  it("falls back to the description, which is the point of searching by it", () => {
    expect(scoreSlashCommand(review, "correctness")).toBeGreaterThan(0);
    expect(scoreSlashCommand(review, "nothing-like-this")).toBe(0);
  });

  it("is case and accent insensitive", () => {
    const skill: SlashCommandInfo = { name: "revisao", description: "Revisão do diff", source: "skill" };
    expect(scoreSlashCommand(skill, "REVISÃO")).toBeGreaterThan(0);
    expect(scoreSlashCommand(skill, "revisao")).toBeGreaterThan(0);
  });
});

describe("filterSlashCommands", () => {
  it("lists everything, in catalogue order, for a bare slash", () => {
    expect(filterSlashCommands(CATALOGUE, "").map((c) => c.name)).toEqual([
      "code-review", "simplify", "systematic-debugging", "superpowers:brainstorm", "compact", "usage",
    ]);
  });

  it("puts the name match first even when a description also matches", () => {
    expect(filterSlashCommands(CATALOGUE, "simpl")[0]!.name).toBe("simplify");
  });

  it("finds a command by what it DOES, not only by its name", () => {
    expect(filterSlashCommands(CATALOGUE, "bug").map((c) => c.name)).toContain("systematic-debugging");
  });

  it("drops what does not match at all, and caps the list", () => {
    expect(filterSlashCommands(CATALOGUE, "zzzz")).toEqual([]);
    expect(filterSlashCommands(CATALOGUE, "", 2)).toHaveLength(2);
  });
});

describe("applySlashPick", () => {
  it("leaves the field with the command and a caret where its arguments go", () => {
    expect(applySlashPick(CATALOGUE[0]!)).toBe("/code-review ");
    expect(applySlashPick(CATALOGUE[4]!)).toBe("/compact ");
  });
});

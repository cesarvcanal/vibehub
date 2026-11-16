import { describe, expect, it } from "vitest";
import { defaultReviewerId, isPrAuthor } from "./analysisRoles";

const people = [
  { id: "u1", username: "sam", githubLogin: "Sam-GH" },
  { id: "u2", username: "kim" },
];

describe("analysis roles", () => {
  it("recognises the PR's author by GitHub login, case aside; without a login nobody is the author", () => {
    expect(isPrAuthor(people[0]!, { author: "sam-gh" })).toBe(true);
    expect(isPrAuthor(people[1]!, { author: "sam-gh" })).toBe(false);
  });

  it("picks the one signed in as reviewer, never when they opened the PR", () => {
    expect(defaultReviewerId(people, "u1", { author: "other" })).toBe("u1");
    expect(defaultReviewerId(people, "u1", { author: "sam-gh" })).toBe("");
    expect(defaultReviewerId(people, "nobody", { author: "other" })).toBe("");
  });
});

import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redactSecrets.js";

describe("redactSecrets", () => {
  it("redacts token-looking strings but leaves git SHAs alone", () => {
    const sha = "a".repeat(40);
    const redacted = redactSecrets(`tok ghp_${"A".repeat(36)} and github_pat_${"B".repeat(30)} and ${sha}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("ghp_A");
    expect(redacted).not.toContain("github_pat_B");
    expect(redacted).toContain(sha);
  });
});

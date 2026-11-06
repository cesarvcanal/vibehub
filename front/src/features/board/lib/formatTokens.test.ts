import { afterEach, describe, it, expect } from "vitest";
import { formatTokens } from "./sdkDetail";
import { resetLanguage, setLanguage } from "@/i18n";

describe("formatTokens", () => {
  afterEach(() => resetLanguage());

  it.each([
    [900, "900"],
    [41_000, "41k"],
    [999_499, "999k"],
    [999_600, "1M"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
  ])("%s → %s", (n, out) => {
    setLanguage("en");
    expect(formatTokens(n)).toBe(out);
  });

  it("em português, milhão com vírgula", () => {
    setLanguage("pt-BR");
    expect(formatTokens(1_500_000)).toBe("1,5 mi");
    expect(formatTokens(1_000_000)).toBe("1 mi");
    expect(formatTokens(41_000)).toBe("41 mil");
  });
});

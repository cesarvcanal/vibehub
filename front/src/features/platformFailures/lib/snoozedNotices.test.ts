import { describe, it, expect, beforeEach } from "vitest";
import type { PlatformFailureNotice } from "@/api/types";
import { buildSnoozeKey, pickVisibleNotices, readSnoozedNoticeKeys, saveSnoozedNoticeKeys } from "./snoozedNotices";

const notice = (id: string, firstSeenAt: number, status: PlatformFailureNotice["status"] = "open"): PlatformFailureNotice =>
  ({ id, source: "agent_report", status, occurrences: 1, firstSeenAt });

beforeEach(() => localStorage.clear());

describe("avisos de falha adiados com 'agora não'", () => {
  it("mostra do mais recente para o mais antigo, sem os adiados deste card", () => {
    const snoozed = new Set([buildSnoozeKey("card-1", notice("b", 2))]);
    expect(pickVisibleNotices([notice("a", 1), notice("b", 2), notice("c", 3)], snoozed, "card-1").map((shown) => shown.id)).toEqual(["c", "a"]);
  });

  it("o adiamento vale só para o status em que foi feito", () => {
    const snoozed = new Set([buildSnoozeKey("card-1", notice("a", 1, "open"))]);
    expect(pickVisibleNotices([notice("a", 1, "investigating")], snoozed, "card-1")).toHaveLength(1);
  });

  it("guarda e relê os adiados, mantendo só os 200 mais novos", () => {
    const keys = Array.from({ length: 205 }, (_unused, index) => `card-1:f${index}:open`);
    saveSnoozedNoticeKeys(new Set(keys));
    const stored = readSnoozedNoticeKeys();
    expect(stored.size).toBe(200);
    expect(stored.has("card-1:f204:open")).toBe(true);
    expect(stored.has("card-1:f0:open")).toBe(false);
  });

  it.each([
    ["um texto que não é JSON", "{quebrado", []],
    ["uma lista com itens que não são texto", JSON.stringify([1, "card-1:f1:open"]), ["card-1:f1:open"]],
  ])("o que outra versão deixou guardado (%s) só vale pelos textos", (_case, storedValue, expectedKeys) => {
    localStorage.setItem("vibehub.platformFailures.snoozed", storedValue);
    expect([...readSnoozedNoticeKeys()]).toEqual(expectedKeys);
  });
});

import { describe, it, expect } from "vitest";
import { nextBackupAccount } from "./fallback.js";

const NOW = 1_800_000_000_000;
const BACKUPS = new Map([
  ["albert", "cesar"],
  ["cesar", "mussa"],
]);
const CYCLE = new Map([
  ["albert", "cesar"],
  ["cesar", "albert"],
]);

describe("nextBackupAccount", () => {
  it.each([
    ["albert estourou, reserva cesar → cesar", "albert", BACKUPS, [], "cesar"],
    ["cesar também esgotada, segue para mussa", "albert", BACKUPS, [{ account: "cesar", renewsAt: NOW + 60_000 }], "mussa"],
    ["ciclo albert→cesar→albert para em null", "cesar", CYCLE, [{ account: "albert", renewsAt: NOW + 60_000 }], null],
    ["sem reserva configurada → null", "mussa", BACKUPS, [], null],
    ["conta esgotada que já renovou volta a valer", "cesar", CYCLE, [{ account: "albert", renewsAt: NOW - 1 }], "albert"],
    ["esgotada sem horário de renovação não volta na mesma cadeia", "cesar", CYCLE, [{ account: "albert" }], null],
    ["a conta que acabou de estourar nunca é a próxima", "albert", CYCLE, [], "cesar"],
  ])("%s", (_case, from, backups, exhausted, expected) => {
    const next = nextBackupAccount({ from, backupOf: (account) => backups.get(account), exhausted, now: NOW });

    expect(next).toBe(expected);
  });
});

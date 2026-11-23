import { describe, it, expect } from "vitest";
import { backupChainOf, nextBackupAccount } from "./backupChain.js";

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
    ["cesar também esgotada, segue para mussa", "albert", BACKUPS, [{ accountSlug: "cesar", renewsAt: NOW + 60_000 }], "mussa"],
    ["ciclo albert→cesar→albert para em null", "cesar", CYCLE, [{ accountSlug: "albert", renewsAt: NOW + 60_000 }], null],
    ["sem reserva configurada → null", "mussa", BACKUPS, [], null],
    ["conta esgotada que já renovou volta a valer", "cesar", CYCLE, [{ accountSlug: "albert", renewsAt: NOW - 1 }], "albert"],
    ["esgotada sem horário de renovação não volta na mesma cadeia", "cesar", CYCLE, [{ accountSlug: "albert" }], null],
    ["a conta que acabou de estourar nunca é a próxima", "albert", CYCLE, [], "cesar"],
  ])("%s", (_case, from, backups, exhausted, expected) => {
    const next = nextBackupAccount({ from, backupOf: (accountSlug) => backups.get(accountSlug), exhausted, now: NOW });

    expect(next).toBe(expected);
  });
});

describe("backupChainOf", () => {
  it.each([
    ["segue a reserva de cada conta, na ordem", "albert", BACKUPS, ["cesar", "mussa"]],
    ["para antes de repetir uma conta do ciclo", "albert", CYCLE, ["cesar"]],
    ["conta sem reserva não tem cadeia", "mussa", BACKUPS, []],
  ])("%s", (_case, from, backups, expected) => {
    expect(backupChainOf(from, (accountSlug) => backups.get(accountSlug))).toEqual(expected);
  });
});

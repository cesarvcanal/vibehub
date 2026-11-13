import { describe, it, expect } from "vitest";
import { nextIdentity } from "./viewerIdentity";

/**
 * The chat reconnects when the ACCOUNT changes — the server stamps the author per connection, so a
 * socket opened as "mussa" keeps writing as "mussa" after the tab became "cesar". But only when
 * it really changes: /auth/me arriving (nothing → someone) or the session dropping (someone → nothing)
 * are not an account switch, and reconnecting in those cases would only make the conversation flicker.
 */
describe("nextIdentity — quando a troca de conta exige uma conexão nova", () => {
  const start = { id: null, epoch: 0 };

  it("a primeira identidade conhecida não reconecta", () => {
    expect(nextIdentity(start, "1")).toEqual({ id: "1", epoch: 0 });
  });

  it("a mesma conta de novo (refetch do /auth/me) não reconecta", () => {
    const known = nextIdentity(start, "1");
    expect(nextIdentity(known, "1")).toBe(known);
  });

  it("outra conta reconecta", () => {
    const known = nextIdentity(start, "1");
    expect(nextIdentity(known, "2")).toEqual({ id: "2", epoch: 1 });
  });

  it("a sessão sumindo (logout, 401) não reconecta — e não esquece quem era", () => {
    const known = nextIdentity(start, "1");
    expect(nextIdentity(known, null)).toBe(known);
    // voltou a MESMA conta: nada muda; voltou outra: reconecta
    expect(nextIdentity(nextIdentity(known, null), "1")).toBe(known);
    expect(nextIdentity(nextIdentity(known, null), "2")).toEqual({ id: "2", epoch: 1 });
  });
});

import { describe, it, expect } from "vitest";
import { nextIdentity } from "./viewerIdentity";

/**
 * O chat reconecta quando a CONTA muda — o servidor carimba o autor por conexão, então um socket
 * aberto como "mussa" continua escrevendo como "mussa" depois que a aba virou "cesar". Mas só
 * quando muda de verdade: o /auth/me chegando (nada → alguém) ou a sessão caindo (alguém → nada)
 * não são troca de conta, e reconectar nesses casos só faria a conversa piscar.
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

import { describe, it, expect } from "vitest";
import { repoAccessRefusal } from "./repoAccess";

const failure = (status: number, data: unknown) => Object.assign(new Error(`status ${status}`), { response: { status, data } });

describe("repoAccessRefusal", () => {
  it("reads the account and the repository out of the list's no-access refusal", () => {
    const err = failure(403, { error: "sem_acesso_repo: a conta GitHub albert-gh não tem acesso a acme/erp", login: "albert-gh", repo: "acme/erp" });
    expect(repoAccessRefusal(err)).toEqual({ login: "albert-gh", repo: "acme/erp" });
  });

  it("any other 403 (a proxy, a body of another shape) is not this refusal", () => {
    expect(repoAccessRefusal(failure(403, "<html>Forbidden</html>"))).toBeNull();
    expect(repoAccessRefusal(failure(403, { error: "forbidden" }))).toBeNull();
    expect(repoAccessRefusal(failure(403, { error: "sem_acesso_repo: x", login: 7, repo: "acme/erp" }))).toBeNull();
  });

  it("another status or no response at all is not this refusal", () => {
    expect(repoAccessRefusal(failure(502, { error: "sem_acesso_repo: x", login: "a", repo: "b/c" }))).toBeNull();
    expect(repoAccessRefusal(new Error("Network Error"))).toBeNull();
    expect(repoAccessRefusal(null)).toBeNull();
  });
});

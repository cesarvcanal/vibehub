import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { dropSession, ME_KEY, SETUP_STATE_KEY } from "@/providers/auth";
import type { User } from "@/api/types";

const operator: User = { id: "u1", username: "operator", role: "owner" };

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** What leaving a session must leave behind — and what it must not. */
describe("dropSession", () => {
  /**
   * The focus revalidation (SessionGuard) may already be asking `/auth/me` when the logout lands.
   * That answer was computed BEFORE the logout: arriving afterwards it must not write the user back
   * and put the board on screen again.
   */
  it("a /auth/me answer already in flight does not resurrect the session", async () => {
    const qc = client();
    let answer: (user: User) => void = () => {};
    const observer = new QueryObserver<User | null>(qc, {
      queryKey: ME_KEY,
      queryFn: () => new Promise<User>((resolve) => { answer = resolve; }),
    });
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve(); // the fetch is under way

    await dropSession(qc);
    answer(operator); // the stale answer arrives after the logout
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(qc.getQueryData(ME_KEY)).toBeNull();
    unsubscribe();
  });

  /** `clear()` emptied the mutation cache too — and mutation variables hold passwords, tokens, keys. */
  it("forgets the mutations — their variables can hold secrets", async () => {
    const qc = client();
    await qc.getMutationCache()
      .build(qc, { mutationFn: async () => "ok" })
      .execute({ secret: "sk-123" });
    expect(qc.getMutationCache().getAll()).toHaveLength(1);

    await dropSession(qc);

    expect(qc.getMutationCache().getAll()).toHaveLength(0);
  });

  /** Only the two keys it names survive — not everything that happens to start with "auth"/"setup". */
  it("keeps exactly the session answer and the public setup probe", async () => {
    const qc = client();
    qc.setQueryData(ME_KEY, operator);
    qc.setQueryData(SETUP_STATE_KEY, { fresh: false });
    qc.setQueryData(["auth", "sessions"], ["laptop", "phone"]);
    qc.setQueryData(["setup", "secrets"], { token: "x" });
    qc.setQueryData(["board", "cards"], [1, 2, 3]);

    await dropSession(qc);

    expect(qc.getQueryData(ME_KEY)).toBeNull();
    expect(qc.getQueryData(SETUP_STATE_KEY)).toEqual({ fresh: false });
    expect(qc.getQueryData(["auth", "sessions"])).toBeUndefined();
    expect(qc.getQueryData(["setup", "secrets"])).toBeUndefined();
    expect(qc.getQueryData(["board", "cards"])).toBeUndefined();
  });
});

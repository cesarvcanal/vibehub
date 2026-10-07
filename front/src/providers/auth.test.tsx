import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { SessionGuard } from "@/components/SessionGuard";
import { useAuth } from "@/providers/auth";
import { apiReject, renderApp, setupState } from "@/test/render";
import { get, post, setUnauthorizedHandler } from "@/lib/api";
import type { User } from "@/api/types";

vi.mock("@/lib/api", () => ({
  api: { interceptors: { response: { use: vi.fn() } } },
  setUnauthorizedHandler: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

const mockGet = vi.mocked(get);
const mockPost = vi.mocked(post);
const mockSetUnauthorizedHandler = vi.mocked(setUnauthorizedHandler);

const operator: User = { id: "u1", username: "operator", role: "owner" };

/** The server's view of the session: flipping it is what logout / expiry does. */
let sessionAlive = true;

function server() {
  mockGet.mockImplementation((url: string) => {
    if (url === "/setup/state") return Promise.resolve(setupState());
    if (url === "/auth/me") {
      return sessionAlive
        ? Promise.resolve({ user: operator })
        : Promise.reject(apiReject(401, "no session"));
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

let auth: ReturnType<typeof useAuth> | null = null;

function Probe() {
  auth = useAuth();
  return <p>{auth.isAuthenticated ? `signed in as ${auth.user?.username}` : "signed out"}</p>;
}

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionAlive = true;
    auth = null;
    server();
  });

  // queryClient.clear() drops the cache WITHOUT telling the useQuery(ME_KEY) observer, so the
  // provider kept handing out the old user: PublicRoute bounced /login back to the board, the
  // board 401'd, and round it went.
  it("signOut leaves the provider signed out, not holding the old user", async () => {
    mockPost.mockImplementation(() => {
      sessionAlive = false;
      return Promise.resolve({});
    });
    renderApp(<Probe />);
    expect(await screen.findByText("signed in as operator")).toBeInTheDocument();

    await act(async () => {
      await auth?.signOut();
    });

    await waitFor(() => expect(screen.getByText("signed out")).toBeInTheDocument());
    expect(auth?.user).toBeNull();
  });

  it("a 401 from any request drops the session the provider exposes", async () => {
    renderApp(
      <>
        <SessionGuard />
        <Probe />
      </>,
    );
    expect(await screen.findByText("signed in as operator")).toBeInTheDocument();

    const onUnauthorized = mockSetUnauthorizedHandler.mock.calls
      .map(([handler]) => handler)
      .filter((handler) => handler !== null)
      .at(-1);
    expect(onUnauthorized).toBeTypeOf("function");

    sessionAlive = false;
    act(() => onUnauthorized?.());

    await waitFor(() => expect(screen.getByText("signed out")).toBeInTheDocument());
  });

  // Changing your own password revokes every cookie signed before it — the one an in-flight poll is
  // carrying included — and the fresh cookie is still on its way back. That poll's 401 is not "you
  // are signed out": the session itself is fine, and asking /auth/me again says so.
  it("a 401 the session itself contradicts keeps the person signed in", async () => {
    renderApp(
      <>
        <SessionGuard />
        <Probe />
      </>,
    );
    expect(await screen.findByText("signed in as operator")).toBeInTheDocument();
    const onUnauthorized = mockSetUnauthorizedHandler.mock.calls
      .map(([handler]) => handler)
      .filter((handler) => handler !== null)
      .at(-1);
    const meCalls = () => mockGet.mock.calls.filter(([url]) => url === "/auth/me").length;
    const before = meCalls();

    act(() => onUnauthorized?.());

    await waitFor(() => expect(meCalls()).toBeGreaterThan(before));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByText("signed in as operator")).toBeInTheDocument();
  });

  it("signOut still drops the rest of the cache (no data from a dead session)", async () => {
    mockPost.mockResolvedValue({});
    const { queryClient } = renderApp(<Probe />);
    expect(await screen.findByText("signed in as operator")).toBeInTheDocument();
    queryClient.setQueryData(["board", "projects"], [{ id: "p1" }]);

    await act(async () => {
      await auth?.signOut();
    });

    expect(queryClient.getQueryData(["board", "projects"])).toBeUndefined();
  });
});

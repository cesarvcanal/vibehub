import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

let dir = "";
let app: FastifyInstance;
let cookie = "";

const RUNNER_TOKEN = "runner-token-abcdef";

/** The status hook's only side effect on the runner: the deferred restart of a flagged card. */
const restartCard = vi.fn(async (id: string) => ({ id }));
/** Creating a card kicks the workspace off in the BACKGROUND — the runner is not part of this suite. */
const prepareCard = vi.fn(async (id: string) => ({ id }));
/** Session side effects of a DRAG between columns. The pause still writes the board for real, so
 *  the response the route sends back is the honest one. */
const pauseCard = vi.fn(async (id: string) => (await registry()).pauseCard(id, { effective: true }));
const resumeCard = vi.fn(async (id: string) => ({ id }));
/** Ending the tmux sessions of a card — what a pause that comes DUE has to do in the runner. */
const killCardSession = vi.fn(async () => undefined);

/** The registry the running app is using (same module instance — boot() resets the graph first). */
async function registry(): Promise<typeof import("../services/board/registry.js")> {
  return await import("../services/board/registry.js");
}

async function boot(): Promise<FastifyInstance> {
  vi.resetModules();
  const env = await import("../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  env.config.sessionSecret = "";
  env.config.insecureCookies = true;
  vi.doMock("../runtime/runner.js", () => ({
    provisionRunner: vi.fn(async () => undefined),
    startRunner: vi.fn(async () => undefined),
    runnerToken: vi.fn(async () => RUNNER_TOKEN),
    runnerStatus: vi.fn(async () => ({
      running: true, exists: true, claudeInstalled: true, dockerReachable: true,
      container: "vibehub-runner", host: "this machine",
    })),
  }));
  vi.doMock("../services/board/workspace.js", async () => {
    const actual = await vi.importActual<typeof import("../services/board/workspace.js")>("../services/board/workspace.js");
    return { ...actual, restartCard, prepareCard, pauseCard, resumeCard, killCardSession };
  });
  const { buildServer } = await import("../index.js");
  const server = await buildServer();
  await server.ready();
  return server;
}

async function signIn(): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/setup/owner", payload: { username: "owner", password: "supersecret" },
  });
  return `vibehub_session=${res.cookies.find((c) => c.name === "vibehub_session")?.value ?? ""}`;
}

async function makeProject(name = "vibehub"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name } });
  return res.json().project.id as string;
}

async function makeCard(projectId: string, title = "first card"): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title },
  });
  return res.json().card.id as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-board-routes-"));
  vi.clearAllMocks();
  app = await boot();
  cookie = await signIn();
});
afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

describe("projects", () => {
  it("creates, lists and deletes", async () => {
    const id = await makeProject();
    const list = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
    expect(list.json().projects).toHaveLength(1);
    const del = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } })).json().projects).toHaveLength(0);
  });

  it("returns the cascaded cards so the session layer can tear them down", async () => {
    const id = await makeProject();
    await makeCard(id, "one");
    await makeCard(id, "two");
    const del = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { cookie } });
    expect(del.json().cards).toHaveLength(2);
  });

  it("400s a project with no name and 404s an unknown id", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: " " } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "PATCH", url: "/api/projects/does-not-exist", headers: { cookie }, payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a repository name that is not owner/repo", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "p", repoFullName: "not-a-repo; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reorders the sidebar", async () => {
    const first = await makeProject("first");
    await makeProject("second");
    const res = await app.inject({
      method: "PATCH", url: `/api/projects/${first}/order`, headers: { cookie }, payload: { position: 1 },
    });
    expect(res.json().projects.map((p: { name: string }) => p.name)).toEqual(["second", "first"]);
  });

  it("400s a bogus position", async () => {
    const id = await makeProject();
    const res = await app.inject({
      method: "PATCH", url: `/api/projects/${id}/order`, headers: { cookie }, payload: { position: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("cards", () => {
  it("creates a card in the backlog with derived session and worktree names", async () => {
    const projectId = await makeProject();
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title: "Refatorar Ação!" },
    });
    const card = res.json().card;
    expect(card.column).toBe("backlog");
    expect(card.tmuxSession).toMatch(/^card-[0-9a-f]{8}$/);
    expect(card.worktreeSlug).toMatch(/^[a-z0-9-]+$/);
  });

  it("applies optional fields through the same validation an edit uses", async () => {
    const projectId = await makeProject();
    const ok = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie },
      payload: { projectId, title: "with model", model: "claude-opus-5" },
    });
    expect(ok.json().card.model).toBe("claude-opus-5");
    const bad = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie },
      payload: { projectId, title: "bad model", model: "gpt-9" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("404s an unknown card and 400s an unknown project", async () => {
    expect((await app.inject({ method: "GET", url: "/api/cards/nope", headers: { cookie } })).statusCode).toBe(404);
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId: "nope", title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a branch name carrying shell metacharacters", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    const res = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { branch: "feat/x; rm -rf /" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creating a card PRE-PROVISIONS its workspace in the background (instant first open)", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId, "brand new");
    // The response does not wait for the runner...
    expect(prepareCard).toHaveBeenCalledWith(id, expect.any(String));
    // ...and a failing prepare never turns into a failed creation.
    prepareCard.mockRejectedValueOnce(new Error("docker is down"));
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title: "another" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("dragging a card INTO Paused really pauses it (the session is not left running)", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    await (await registry()).applyOpenTerminal(id);

    const res = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "paused", position: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(pauseCard).toHaveBeenCalledWith(id, expect.any(String));
    expect(res.json().card.column).toBe("paused");
    expect(res.json().card.pausedAt).toBeTypeOf("number");
  });

  it("dragging a card that never ran into Paused just moves it — there is nothing to end", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    const res = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "paused" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.column).toBe("paused");
    expect(pauseCard).not.toHaveBeenCalled();
  });

  it("dragging a paused card back to Waiting RESUMES it; Backlog and Done leave it dormant", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    const reg = await registry();
    await reg.applyOpenTerminal(id);
    await reg.pauseCard(id);

    const res = await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "waiting", position: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.column).toBe("waiting");
    expect(resumeCard).toHaveBeenCalledWith(id, expect.any(String));

    // Back to paused, then dropped in the backlog: a card parked there stays parked.
    await reg.pauseCard(id);
    resumeCard.mockClear();
    await app.inject({
      method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "backlog" },
    });
    expect(resumeCard).not.toHaveBeenCalled();
  });

  it("a rename or a move between live columns touches no session at all", async () => {
    const projectId = await makeProject();
    const id = await makeCard(projectId);
    await (await registry()).applyOpenTerminal(id);
    await app.inject({ method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { title: "renamed" } });
    await app.inject({ method: "PATCH", url: `/api/cards/${id}`, headers: { cookie }, payload: { column: "working" } });
    expect(pauseCard).not.toHaveBeenCalled();
    expect(resumeCard).not.toHaveBeenCalled();
  });

  it("lists cards per project", async () => {
    const a = await makeProject("a");
    const b = await makeProject("b");
    await makeCard(a, "a1");
    await makeCard(b, "b1");
    const res = await app.inject({ method: "GET", url: `/api/projects/${a}/cards`, headers: { cookie } });
    expect(res.json().cards.map((c: { title: string }) => c.title)).toEqual(["a1"]);
  });
});

describe("status callback", () => {
  async function postStatus(card: string, status: string, token?: string) {
    return await app.inject({
      method: "POST", url: "/api/runner/status",
      headers: token ? { "x-vibehub-token": token } : {},
      payload: { card, status },
    });
  }

  it("401s without the service token — and a session cookie is NOT enough", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    expect((await postStatus(card, "working")).statusCode).toBe(401);
    const withCookie = await app.inject({
      method: "POST", url: "/api/runner/status", headers: { cookie }, payload: { card, status: "working" },
    });
    expect(withCookie.statusCode).toBe(401);
  });

  it("401s a wrong token of the same length", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const wrong = "x".repeat(RUNNER_TOKEN.length);
    expect((await postStatus(card, "working", wrong)).statusCode).toBe(401);
  });

  it("moves a card between waiting and working — the mirror rule", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    // A card in the backlog is sticky: a hook must not drag it out.
    await postStatus(card, "working", RUNNER_TOKEN);
    let current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("backlog");

    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "waiting" } });
    await postStatus(card, "working", RUNNER_TOKEN);
    current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("working");

    await postStatus(card, "waiting", RUNNER_TOKEN);
    current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("waiting");
  });

  it("never drags a card out of done on an idle report", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "done" } });
    // `waiting` fires on SessionStart/Stop/Notification, without anybody asking for anything.
    await postStatus(card, "waiting", RUNNER_TOKEN);
    const current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("done");
  });

  it("brings a done card back when somebody actually types in it", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    await app.inject({ method: "PATCH", url: `/api/cards/${card}`, headers: { cookie }, payload: { column: "done" } });
    // `working` means a prompt was submitted in that terminal — the work came back.
    await postStatus(card, "working", RUNNER_TOKEN);
    const current = (await app.inject({ method: "GET", url: `/api/cards/${card}`, headers: { cookie } })).json().card;
    expect(current.column).toBe("working");
  });

  it("carries out a PENDING restart once the flagged card goes idle", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const reg = await import("../services/board/registry.js");
    await reg.applyOpenTerminal(card); // live session
    await postStatus(card, "working", RUNNER_TOKEN);
    // the brain was saved while Claude was busy on this card
    await reg.markRestartPending(card, "brain");

    // still working: the flag stays and nothing is restarted mid-task
    await postStatus(card, "working", RUNNER_TOKEN);
    expect(restartCard).not.toHaveBeenCalled();
    expect((await reg.getCard(card))?.restartPendingAt).toBeGreaterThan(0);

    // Claude finished -> the restart happens now, and the flag is cleared
    expect((await postStatus(card, "waiting", RUNNER_TOKEN)).statusCode).toBe(200);
    expect(restartCard).toHaveBeenCalledTimes(1);
    expect(restartCard).toHaveBeenCalledWith(card);
    expect((await reg.getCard(card))?.restartPendingAt).toBeNull();

    // idempotent: a second idle report has nothing left to do
    await postStatus(card, "waiting", RUNNER_TOKEN);
    expect(restartCard).toHaveBeenCalledTimes(1);
  });

  it("a PAUSE BEATS a pending restart: the card goes to sleep instead of restarting", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const reg = await import("../services/board/registry.js");
    await reg.applyOpenTerminal(card);
    await postStatus(card, "working", RUNNER_TOKEN);
    await reg.pauseCard(card); // pending pause: still working, session alive
    await reg.markRestartPending(card, "mcp");

    expect((await postStatus(card, "waiting", RUNNER_TOKEN)).statusCode).toBe(200);
    expect(restartCard).not.toHaveBeenCalled();
    const after = await reg.getCard(card);
    expect(after?.pausedAt).toBeGreaterThan(0); // the pause happened
    expect(after?.restartPendingAt).toBeNull(); // the restart was dropped
    // ...and `pausedAt` means the session is DEAD, so it really was ended — Claude's and the shell's.
    expect(killCardSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: card }),
      { includeShell: true },
    );
  });

  it("a pending pause that comes DUE ends the tmux sessions — a parked card is not left resident", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const reg = await import("../services/board/registry.js");
    await reg.applyOpenTerminal(card);
    await postStatus(card, "working", RUNNER_TOKEN);
    await reg.pauseCard(card); // dragged into Paused while Claude was really working
    expect(killCardSession).not.toHaveBeenCalled();

    // Claude finishes: the Stop hook is what carries the pause out.
    expect((await postStatus(card, "waiting", RUNNER_TOKEN)).statusCode).toBe(200);
    expect(killCardSession).toHaveBeenCalledTimes(1);
    expect((await reg.getCard(card))?.pausedAt).toBeGreaterThan(0);

    // Idempotent: a later hook on a card with no session left kills nothing again.
    killCardSession.mockClear();
    expect((await postStatus(card, "waiting", RUNNER_TOKEN)).statusCode).toBe(200);
    expect(killCardSession).not.toHaveBeenCalled();
  });

  it("a failing restart does not turn the fire-and-forget hook into an error", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    const reg = await import("../services/board/registry.js");
    await reg.applyOpenTerminal(card);
    await postStatus(card, "working", RUNNER_TOKEN);
    await reg.markRestartPending(card, "brain");

    restartCard.mockRejectedValueOnce(new Error("the runner is not running") as never);
    const res = await postStatus(card, "waiting", RUNNER_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: true });
  });

  it("400s an unknown status value", async () => {
    const projectId = await makeProject();
    const card = await makeCard(projectId);
    expect((await postStatus(card, "thinking", RUNNER_TOKEN)).statusCode).toBe(400);
  });

  it("answers 200 for an unknown card — a fire-and-forget hook must not retry", async () => {
    const res = await postStatus("no-such-card", "working", RUNNER_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, applied: false });
  });
});

describe("accounts", () => {
  it("creates an account and refuses to delete it while a project points at it", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/accounts", headers: { cookie }, payload: { name: "Work Account" },
    });
    const slug = created.json().account.slug;
    await app.inject({
      method: "POST", url: "/api/projects", headers: { cookie },
      payload: { name: "p", defaultAccountSlug: slug },
    });
    const res = await app.inject({ method: "DELETE", url: `/api/accounts/${slug}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });
});

describe("board routes require a session", () => {
  it("401s every board route without a cookie", async () => {
    for (const url of ["/api/projects", "/api/cards", "/api/accounts"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });
});

describe("card creation", () => {
  it("PRE-PROVISIONS the new card in the background, without making the response wait for it", async () => {
    const projectId = await makeProject();
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title: "nova" },
    });
    expect(res.statusCode).toBe(200);
    const card = res.json().card;
    // The response is the CARD, not the workspace: the clone happens alongside it.
    expect(card.preparedAt).toBeUndefined();
    await vi.waitFor(() => expect(prepareCard).toHaveBeenCalledWith(card.id, "card.create"));
  });

  it("pre-provisions with the OPTIONAL fields already applied (account/model/branch reach the script)", async () => {
    const projectId = await makeProject();
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie },
      payload: { projectId, title: "com conta", model: "claude-opus-5", branch: "feat/x" },
    });
    const card = res.json().card;
    expect(card.model).toBe("claude-opus-5");
    expect(card.branch).toBe("feat/x");
    // Fired AFTER the patch: the id is the same card, and by then it already carries the fields.
    await vi.waitFor(() => expect(prepareCard).toHaveBeenCalledWith(card.id, "card.create"));
  });

  it("a pre-provisioning that BLOWS UP never reaches the caller (the first open covers it)", async () => {
    prepareCard.mockRejectedValueOnce(new Error("docker died"));
    const projectId = await makeProject();
    const res = await app.inject({
      method: "POST", url: "/api/cards", headers: { cookie }, payload: { projectId, title: "sem runner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.title).toBe("sem runner");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PLAN USAGE PER ACCOUNT. What is actually dangerous here — and therefore what is pinned:
 *  - the access token never reaches a log line, the response, or argv;
 *  - the docker command is READ-ONLY and fully quoted;
 *  - a profile logged in only by setup-token (no `claudeAiOauth`) is `no_credentials`, not a crash;
 *  - a 429 backs off exponentially and keeps serving the last good numbers as stale;
 *  - a fresh reading is served from cache instead of hitting runner or network again.
 * The board is REAL (temp data dir); the host executor and `fetch` are mocked.
 */

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: vi.fn(),
}));

const ACCESS_TOKEN = "sk-ant-oat-ACCESSTOKEN-do-not-leak-1234567890";

/** A `.credentials.json` as Claude Code writes it after an interactive `/login`. */
function credentials(token = ACCESS_TOKEN): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: 1, scopes: ["user:profile"] },
  });
}

/** The payload of a profile set up ONLY with a long-lived setup-token: no `claudeAiOauth` at all. */
const MCP_ONLY_CREDENTIALS = JSON.stringify({ mcpOAuth: { "some-server": { accessToken: "x" } } });

const USAGE_BODY = {
  five_hour: { utilization: 31.4, resets_at: "2026-08-22T18:00:00Z" },
  seven_day: { utilization: 12, resets_at: "2026-08-27T00:00:00Z" },
  seven_day_opus: { utilization: 74, resets_at: "2026-08-27T00:00:00Z" },
};

let dir = "";
let runScript: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let logged: string[] = [];

/** An HTTP answer shaped the way `fetch` returns one. */
function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fresh(stdout = credentials()) {
  vi.resetModules();
  logged = [];
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "test-key";
  env.config.runner.container = "vibehub-runner";

  const host = await import("../../runtime/host.js");
  runScript = vi.fn(async () => ({ stdout, stderr: "" }));
  vi.mocked(host.hostExecutor).mockReturnValue({
    kind: "local", label: "this machine", runScript,
    writeFile: vi.fn(), ptyCommand: () => ({ file: "bash", args: [] }),
  } as unknown as import("../../runtime/host.js").HostExecutor);

  // Every log line this module writes is captured, so a test can assert the token is in none.
  const { logger } = await import("../../utils/logger.js");
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(args.map((a) => JSON.stringify(a)).join(" "));
    }) as never);
  }

  fetchMock = vi.fn(async () => response(200, USAGE_BODY));
  vi.stubGlobal("fetch", fetchMock);

  const usage = await import("./usage.js");
  usage.resetUsageCache();
  return { usage, registry: await import("../board/registry.js") };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibehub-usage-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe("pure parsing", () => {
  it("reads the Claude Code access token, and only that one", async () => {
    const { usage } = await fresh();
    expect(usage.parseAccessToken(credentials())).toBe(ACCESS_TOKEN);
    // A setup-token profile: the file exists, the block does not.
    expect(usage.parseAccessToken(MCP_ONLY_CREDENTIALS)).toBeUndefined();
    expect(usage.parseAccessToken("")).toBeUndefined();
    expect(usage.parseAccessToken("not json at all")).toBeUndefined();
    expect(usage.parseAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: "   " } }))).toBeUndefined();
  });

  it("clamps utilization and tolerates a window the payload did not send", async () => {
    const { usage } = await fresh();
    expect(usage.parseWindow({ utilization: 140, resets_at: "x" })).toEqual({ utilization: 100, resetsAt: "x" });
    expect(usage.parseWindow({ utilization: -3 })).toEqual({ utilization: 0, resetsAt: null });
    expect(usage.parseWindow({ resets_at: "x" })).toBeUndefined();
    expect(usage.parseUsage({ five_hour: { utilization: 5 } })).toEqual({ fiveHour: { utilization: 5, resetsAt: null } });
    expect(usage.parseUsage({ nothing: true })).toBeUndefined();
  });

  it("classifies a failure by what the operator can do about it", async () => {
    const { usage } = await fresh();
    expect(usage.classifyFailure(429, { error: { type: "rate_limit_error" } })).toBe("rate_limited");
    // A rate-limit envelope at any status is still the endpoint throttling US.
    expect(usage.classifyFailure(200, { error: { type: "rate_limit_error" } })).toBe("rate_limited");
    expect(usage.classifyFailure(401, null)).toBe("unauthorized");
    expect(usage.classifyFailure(403, null)).toBe("unauthorized");
    expect(usage.classifyFailure(400, { error: { type: "invalid_request", message: "missing scope user:profile" } }))
      .toBe("unauthorized");
    expect(usage.classifyFailure(500, null)).toBe("unreachable");
  });

  it("backs off 2min, 4min, 8min… capped at 30min", async () => {
    const { usage } = await fresh();
    expect(usage.backoffMs(1)).toBe(120_000);
    expect(usage.backoffMs(2)).toBe(240_000);
    expect(usage.backoffMs(3)).toBe(480_000);
    expect(usage.backoffMs(4)).toBe(960_000);
    expect(usage.backoffMs(5)).toBe(1_800_000);
    expect(usage.backoffMs(99)).toBe(1_800_000);
  });
});

describe("the docker command", () => {
  it("is a read-only cat of the profile's credential file, fully quoted", async () => {
    const { usage } = await fresh();
    const script = usage.buildReadCredentialsScript("vibehub-runner", "/root/.claude-profiles/tech");
    expect(script).toBe(
      `docker exec 'vibehub-runner' sh -c 'cat "$1" 2>/dev/null || true' _ '/root/.claude-profiles/tech/.credentials.json'`,
    );
    // Nothing that could change a byte inside the runner.
    expect(script).not.toMatch(/\b(rm|mv|cp|chmod|tee|printf|>|sed -i)\b/);
  });

  it("refuses a path that is not an absolute, sane remote path", async () => {
    const { usage } = await fresh();
    expect(() => usage.buildReadCredentialsScript("c", "/root/../etc")).toThrow(/\.\./);
    expect(() => usage.buildReadCredentialsScript("c", "relative/dir")).toThrow(/absolute/);
    expect(() => usage.buildReadCredentialsScript("c", "/root/a b;rm -rf /")).toThrow(/invalid characters/);
  });

  it("reads the EFFECTIVE profile: default outside the profiles dir, an account inside it", async () => {
    const { usage } = await fresh();
    await usage.accountUsage(undefined);
    expect(runScript.mock.calls[0][0]).toContain("'/root/.claude/.credentials.json'");
    usage.resetUsageCache();
    await usage.accountUsage("tech");
    expect(runScript.mock.calls[1][0]).toContain("'/root/.claude-profiles/tech/.credentials.json'");
  });
});

describe("accountUsage", () => {
  it("returns the three windows and sends the bearer plus the oauth beta header", async () => {
    const { usage } = await fresh();
    const result = await usage.accountUsage("tech");
    expect(result.available).toBe(true);
    expect(result.fiveHour).toEqual({ utilization: 31.4, resetsAt: "2026-08-22T18:00:00Z" });
    expect(result.sevenDayOpus).toEqual({ utilization: 74, resetsAt: "2026-08-27T00:00:00Z" });
    expect(result.error).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(usage.USAGE_URL);
    expect(init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("serves a fresh reading from cache — no second docker exec, no second call", async () => {
    const { usage } = await fresh();
    const first = await usage.accountUsage("tech");
    const second = await usage.accountUsage("tech");
    expect(second).toEqual(first);
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls again once the 60s of freshness are gone", async () => {
    const { usage } = await fresh();
    await usage.accountUsage("tech");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + usage.FRESH_MS + 1);
    await usage.accountUsage("tech");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a profile with no interactive login is no_credentials, and never calls the endpoint", async () => {
    const { usage } = await fresh(MCP_ONLY_CREDENTIALS);
    const result = await usage.accountUsage("tech");
    expect(result).toMatchObject({ available: false, error: "no_credentials" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing credential file is the same state", async () => {
    const { usage } = await fresh("");
    expect((await usage.accountUsage("tech")).error).toBe("no_credentials");
  });

  it("a token the endpoint rejects for scope is unauthorized, not no_credentials", async () => {
    const { usage } = await fresh();
    fetchMock.mockResolvedValueOnce(response(401, { error: { type: "authentication_error" } }));
    const result = await usage.accountUsage("tech");
    expect(result).toMatchObject({ available: false, error: "unauthorized" });
  });

  it("a runner that is down is unreachable, not no_credentials", async () => {
    const { usage } = await fresh();
    runScript.mockRejectedValueOnce(new Error("docker: command not found"));
    expect((await usage.accountUsage("tech")).error).toBe("unreachable");
  });

  it("a network failure on the endpoint is unreachable", async () => {
    const { usage } = await fresh();
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect((await usage.accountUsage("tech")).error).toBe("unreachable");
  });
});

describe("rate limiting", () => {
  it("backs off exponentially and serves the last good numbers as stale", async () => {
    const { usage } = await fresh();
    const good = await usage.accountUsage("tech");
    expect(good.available).toBe(true);

    // The window expires, and the endpoint starts throttling us.
    const t1 = Date.now() + usage.FRESH_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(t1);
    fetchMock.mockResolvedValue(response(429, { error: { type: "rate_limit_error" } }));

    const limited = await usage.accountUsage("tech");
    expect(limited.stale).toBe(true);
    expect(limited.error).toBe("rate_limited");
    // The numbers are the good ones, and they still say when they were read.
    expect(limited.fiveHour).toEqual(good.fiveHour);
    expect(limited.fetchedAt).toBe(good.fetchedAt);
    expect(limited.retryAt).toBe(t1 + 120_000);

    // Inside the back-off nothing goes out at all.
    vi.spyOn(Date, "now").mockReturnValue(t1 + 60_000);
    const during = await usage.accountUsage("tech");
    expect(during.stale).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Once it lifts we try once more; a second limit doubles the wait.
    const t2 = t1 + 120_001;
    vi.spyOn(Date, "now").mockReturnValue(t2);
    const again = await usage.accountUsage("tech");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(again.retryAt).toBe(t2 + 240_000);
  });

  it("with no good reading to fall back on it says rate_limited with no numbers", async () => {
    const { usage } = await fresh();
    fetchMock.mockResolvedValue(response(429, { error: { type: "rate_limit_error" } }));
    const result = await usage.accountUsage("tech");
    expect(result).toMatchObject({ available: false, error: "rate_limited" });
    expect(result.fiveHour).toBeUndefined();
    expect(result.retryAt).toBeGreaterThan(Date.now());
  });
});

describe("the token never escapes", () => {
  it("is absent from the response, from every log line, and from argv", async () => {
    const { usage } = await fresh();
    fetchMock.mockResolvedValue(response(429, { error: { type: "rate_limit_error" } }));
    const limited = await usage.accountUsage("tech");
    usage.resetUsageCache();
    fetchMock.mockResolvedValue(response(200, USAGE_BODY));
    const ok = await usage.accountUsage("tech");

    for (const payload of [limited, ok]) {
      expect(JSON.stringify(payload)).not.toContain(ACCESS_TOKEN);
    }
    // The warn line about the back-off was written — and carries no secret.
    expect(logged.some((line) => line.includes("rate-limited"))).toBe(true);
    for (const line of logged) expect(line).not.toContain(ACCESS_TOKEN);
    // The script sent to the host only names the FILE; the value comes back on stdout.
    for (const call of runScript.mock.calls) expect(String(call[0])).not.toContain(ACCESS_TOKEN);
  });
});

describe("allAccountsUsage", () => {
  it("covers the default profile plus every registered account, keyed by slug", async () => {
    const { usage, registry } = await fresh();
    await registry.createAccount({ name: "Tech" });
    await registry.createAccount({ name: "Personal" });

    const { bySlug } = await usage.allAccountsUsage();
    expect(Object.keys(bySlug)).toEqual(["default", "tech", "personal"]);
    expect(bySlug.default.available).toBe(true);
    expect(bySlug.tech.available).toBe(true);
    // One call per account — in series, never a fan-out.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a cached listing costs nothing: no docker exec, no call, no pause", async () => {
    const { usage, registry } = await fresh();
    await registry.createAccount({ name: "Tech" });
    await usage.allAccountsUsage();
    runScript.mockClear();
    fetchMock.mockClear();

    const started = Date.now();
    const { bySlug } = await usage.allAccountsUsage();
    expect(Object.keys(bySlug)).toEqual(["default", "tech"]);
    expect(runScript).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(usage.SERIAL_DELAY_MS);
  });
});

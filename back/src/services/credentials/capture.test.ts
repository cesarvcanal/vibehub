import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

async function fresh() {
  vi.resetModules();
  vi.doMock("../board/registry.js", () => ({ getCard: vi.fn(async () => ({ id: "c1", projectId: "p1" })) }));
  const env = await import("../../config/env.js");
  env.config.dataDir = dir;
  env.config.secretKey = "";
  const capture = await import("./capture.js");
  const creds = await import("./credentials.js");
  capture.resetCaptureForTesting();
  return { capture, creds };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vibehub-cap-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("capture: binding -> pending -> save / discard", () => {
  it("records a captured login as pending WITHOUT ever exposing the password", async () => {
    const { capture } = await fresh();
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });

    const list = capture.listCaptures("c1");
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("erp.multi");
    expect(list[0].username).toBe("ada");
    expect(list[0].suggestedName).toBe("erp.multi");
    // The sanitized view must NEVER carry the password.
    expect(JSON.stringify(list)).not.toContain("s3cr3t");
    expect(Object.keys(list[0])).not.toContain("password");
  });

  it("ignores a report with no password", async () => {
    const { capture } = await fresh();
    capture.recordCapture("c1", { url: "https://x/login", username: "u" });
    expect(capture.listCaptures("c1")).toHaveLength(0);
  });

  it("dedupes on host+username, newest wins", async () => {
    const { capture } = await fresh();
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "old" });
    capture.recordCapture("c1", { url: "https://erp.multi/x", username: "ada", password: "new" });
    expect(capture.listCaptures("c1")).toHaveLength(1);
  });

  it("saving a capture creates a userpass credential from the server-held value", async () => {
    const { capture, creds } = await fresh();
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    const pending = capture.listCaptures("c1")[0];

    const credential = await capture.saveCapture(pending.id, "erp-prod");
    expect(credential.name).toBe("erp-prod");
    expect(credential.type).toBe("userpass");

    // The value made it into the vault (resolvable), and the pending entry is gone.
    const resolved = await creds.resolveCredential("erp-prod");
    expect(resolved.username).toBe("ada");
    expect(resolved.secret).toBe("s3cr3t");
    expect(capture.listCaptures("c1")).toHaveLength(0);
  });

  it("a capture with no username saves as a token", async () => {
    const { capture, creds } = await fresh();
    capture.recordCapture("c1", { url: "https://tok.site/login", username: "", password: "just-a-token" });
    const pending = capture.listCaptures("c1")[0];
    const credential = await capture.saveCapture(pending.id, undefined);
    expect(credential.type).toBe("token");
    expect((await creds.resolveCredential(pending.suggestedName)).secret).toBe("just-a-token");
  });

  it("dismiss drops the pending capture without saving", async () => {
    const { capture, creds } = await fresh();
    capture.recordCapture("c1", { url: "https://x/login", username: "u", password: "p" });
    const pending = capture.listCaptures("c1")[0];
    expect(capture.dismissCapture(pending.id)).toBe(true);
    expect(capture.listCaptures("c1")).toHaveLength(0);
    expect(await creds.listCredentials()).toHaveLength(0);
    // Saving a dismissed capture fails clearly.
    await expect(capture.saveCapture(pending.id, "x")).rejects.toThrow(/no longer available/);
  });

  it("hostFromUrl and publicCapture are pure and password-free", async () => {
    const { capture } = await fresh();
    expect(capture.hostFromUrl("https://space.com:8443/a")).toBe("space.com:8443");
    expect(capture.hostFromUrl("garbage")).toBe("garbage");
  });
});

describe("dropPendingCaptures (the card is being deleted)", () => {
  it("forgets the captures of that card — they hold a PLAINTEXT password in memory", async () => {
    const { capture } = await fresh();
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    capture.recordCapture("c1", { url: "https://space/login", username: "ada", password: "outro" });
    capture.recordCapture("c2", { url: "https://erp.multi/login", username: "bob", password: "fica" });

    expect(capture.dropPendingCaptures("c1")).toBe(2);
    expect(capture.listCaptures("c1")).toEqual([]);
    // Another card's pending login is none of this card's business.
    expect(capture.listCaptures("c2")).toHaveLength(1);
    expect(capture.dropPendingCaptures("c1")).toBe(0);
  });
});

describe("capture: an agent saving its own card's capture", () => {
  it("is refused unless the card's project is opted in", async () => {
    const { capture, creds } = await fresh();
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    const [cap] = capture.listCaptures("c1");
    await expect(capture.saveCaptureForCard("c1", cap!.id, "erp")).rejects.toThrow(/Settings . Cofre/);
    expect(await creds.listCredentials()).toHaveLength(0);
    // Refused means untouched: the capture is still there for the owner to save.
    expect(capture.listCaptures("c1")).toHaveLength(1);
  });

  it("saves it with the agent origin once opted in, and the capture is consumed", async () => {
    const { capture, creds } = await fresh();
    await creds.setAgentWriteProjects(["p1"]);
    capture.recordCapture("c1", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    const [cap] = capture.listCaptures("c1");
    const saved = await capture.saveCaptureForCard("c1", cap!.id, undefined, "card");
    expect(saved).toMatchObject({ name: "erp.multi", type: "userpass", origin: { cardId: "c1", projectId: "p1", via: "capture" } });
    expect(JSON.stringify(saved)).not.toContain("s3cr3t");
    expect((await creds.resolveCredential("erp.multi")).secret).toBe("s3cr3t");
    expect(capture.listCaptures("c1")).toHaveLength(0);
  });

  it("cannot save another card's capture", async () => {
    const { capture, creds } = await fresh();
    await creds.setAgentWriteProjects(["p1"]);
    capture.recordCapture("other-card", { url: "https://erp.multi/login", username: "ada", password: "s3cr3t" });
    const [cap] = capture.listCaptures("other-card");
    await expect(capture.saveCaptureForCard("c1", cap!.id, "erp")).rejects.toThrow(/no longer available/);
    expect(await creds.listCredentials()).toHaveLength(0);
  });
});

describe("capture listener stdout", () => {
  it("keeps a multibyte character whole when the pipe splits it between chunks", async () => {
    const { PassThrough } = await import("node:stream");
    const { EventEmitter } = await import("node:events");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.doMock("node:child_process", async (orig) => ({
      ...(await orig<typeof import("node:child_process")>()),
      spawn: vi.fn(() => child),
    }));
    const { capture } = await fresh();
    capture.startCapture("c1");

    const line = Buffer.from(`${JSON.stringify({ type: "capture", url: "https://erp.multi/login", username: "joão", password: "senhaé" })}\n`, "utf8");
    const cut = line.indexOf(Buffer.from("ã", "utf8")) + 1; // inside the two bytes of "ã"
    child.stdout.write(line.subarray(0, cut));
    child.stdout.write(line.subarray(cut));
    await new Promise((r) => setImmediate(r));

    expect(capture.listCaptures("c1").map((c) => c.username)).toEqual(["joão"]);
    capture.stopCapture("c1");
    vi.doUnmock("node:child_process");
  });
});

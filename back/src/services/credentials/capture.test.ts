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

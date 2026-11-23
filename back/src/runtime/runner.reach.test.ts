import { describe, it, expect, beforeEach, vi } from "vitest";

const runScript = vi.fn();
vi.mock("./host.js", async (orig) => ({
  ...(await orig<typeof import("./host.js")>()),
  hostExecutor: () => ({ runScript }),
}));

const { logger } = await import("../utils/logger.js");
const { checkStatusHookReach, statusProbeVerdict } = await import("./runner.js");

describe("statusProbeVerdict", () => {
  it("an HTTP code is reachable, curl's 000 is unreachable, no code at all is unknown", () => {
    // 401 without a token is the route alive
    expect(statusProbeVerdict("401")).toBe("reachable");
    expect(statusProbeVerdict("400\n")).toBe("reachable");
    expect(statusProbeVerdict("000")).toBe("unreachable"); // production, 21/10/2026: the dead blue/green port
    // docker exec never ran curl (runner down, no docker): nothing proves the URL is wrong
    expect(statusProbeVerdict("")).toBe("unknown");
    expect(statusProbeVerdict("curl: (7) refused")).toBe("unknown");
  });
});

describe("checkStatusHookReach", () => {
  beforeEach(() => {
    runScript.mockReset();
    vi.restoreAllMocks();
  });

  it("a runner that is down does not blame the public URL", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValue({ stdout: "", stderr: "" });
    await checkStatusHookReach();
    runScript.mockRejectedValue(new Error("bash: docker: command not found"));
    await checkStatusHookReach();
    expect(error).not.toHaveBeenCalled();
  });

  it("curl answering 000 from inside the runner is the loud public-URL error, once", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" }); // the verdict is module state
    expect(await checkStatusHookReach()).toBe(true);
    runScript.mockResolvedValue({ stdout: "000", stderr: "" });
    expect(await checkStatusHookReach()).toBe(false);
    expect(await checkStatusHookReach()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("one failed probe between two that answered is a blip, not the public-URL error", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    runScript.mockResolvedValueOnce({ stdout: "000", stderr: "" });
    expect(await checkStatusHookReach()).toBe(false);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    expect(await checkStatusHookReach()).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("the public-URL error waits for the second failed probe in a row and is not repeated while the URL stays down", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    runScript.mockResolvedValue({ stdout: "000", stderr: "" });
    await checkStatusHookReach();
    expect(error).not.toHaveBeenCalled();
    await checkStatusHookReach();
    expect(error).toHaveBeenCalledTimes(1);
    await checkStatusHookReach();
    await checkStatusHookReach();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("after the error, an answered probe logs the recovery and a new pair of failures alerts again", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    const probeStdouts = ["000", "000", "401", "000", "000"];
    for (const stdout of probeStdouts) {
      runScript.mockResolvedValueOnce({ stdout, stderr: "" });
      await checkStatusHookReach();
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ action: "runner.statusHook.reachable" }), expect.any(String));
  });

  it("an unknown pass between two failures keeps the count, so the second failure alerts once", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    runScript.mockResolvedValueOnce({ stdout: "000", stderr: "" });
    await checkStatusHookReach();
    runScript.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await checkStatusHookReach();
    runScript.mockResolvedValueOnce({ stdout: "000", stderr: "" });
    await checkStatusHookReach();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

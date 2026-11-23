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

  it("curl answering 000 on two probes in a row is the loud public-URL error", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" }); // the verdict is module state
    expect(await checkStatusHookReach()).toBe(true);
    runScript.mockResolvedValue({ stdout: "000", stderr: "" });
    expect(await checkStatusHookReach()).toBe(false);
    expect(await checkStatusHookReach()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a single 000 that the next probe contradicts does not blame the public URL", async () => {
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "000", stderr: "" });
    expect(await checkStatusHookReach()).toBe(false);
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    expect(await checkStatusHookReach()).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("a failure that persists raises the error once, and again only after a recovery", async () => {
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const probeCodes = ["000", "000", "000", "000"];
    for (const code of probeCodes) {
      runScript.mockResolvedValueOnce({ stdout: code, stderr: "" });
      await checkStatusHookReach();
    }
    expect(error).toHaveBeenCalledTimes(1);
    const probeCodesAfterRecovery = ["401", "000", "000"];
    for (const code of probeCodesAfterRecovery) {
      runScript.mockResolvedValueOnce({ stdout: code, stderr: "" });
      await checkStatusHookReach();
    }
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("after the alarm, the first answering probe logs the recovery once", async () => {
    runScript.mockResolvedValueOnce({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    runScript.mockResolvedValueOnce({ stdout: "000", stderr: "" }).mockResolvedValueOnce({ stdout: "000", stderr: "" });
    await checkStatusHookReach();
    await checkStatusHookReach();
    runScript.mockResolvedValue({ stdout: "401", stderr: "" });
    await checkStatusHookReach();
    await checkStatusHookReach();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("an unknown pass between two failures does not reset the count toward the alarm", async () => {
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

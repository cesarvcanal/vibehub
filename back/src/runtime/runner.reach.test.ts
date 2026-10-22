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
    expect(statusProbeVerdict("401")).toBe("reachable");
    expect(statusProbeVerdict("000")).toBe("unreachable");
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

  it("an unknown pass between two failures does not re-raise the error", async () => {
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

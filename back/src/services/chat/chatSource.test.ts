import { describe, it, expect, vi, beforeEach } from "vitest";
import { config } from "../../config/env.js";
import { resetHostExecutorForTesting } from "../../runtime/host.js";

/**
 * The follow command's OUTPUT is read over plain pipes, line by line (the chat websocket and the
 * SDK transcript mirror both spawn it with `stdio: pipe`). Across an ssh hop, the PTY command adds
 * `-tt` — a terminal in the middle that rewrites line endings and puts a tty where the follow's
 * stdin-liveness check expects the pipe from the backend. The REAL executor is used here, because
 * which argv each mode produces is the property under test.
 */

vi.mock("../board/registry.js", async (orig) => ({
  ...(await orig<typeof import("../board/registry.js")>()),
  getCard: vi.fn(async () => ({ id: "c1", title: "a card", projectId: "p1" })),
  getProject: vi.fn(async () => ({ id: "p1" })),
}));
vi.mock("../maestro/maestro.js", async (orig) => ({
  ...(await orig<typeof import("../maestro/maestro.js")>()),
  transcriptDirFor: () => "/root/.claude/projects/-work-p1-c1",
}));

beforeEach(() => {
  config.runner.kind = "ssh";
  config.runner.sshHost = "10.0.0.5";
  config.runner.sshUser = "root";
  resetHostExecutorForTesting();
});

describe("chatSource", () => {
  it("follows the transcript through a PIPE command — no tty across the ssh hop", async () => {
    const { chatSource } = await import("./chat.js");
    const { command } = await chatSource("c1");
    expect(command.file).toBe("ssh");
    expect(command.args).not.toContain("-tt");
    expect(command.args[command.args.length - 1]).toContain("/root/.claude/projects/-work-p1-c1");
  });
});

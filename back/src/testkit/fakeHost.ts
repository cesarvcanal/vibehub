import { vi } from "vitest";

export type FakeRunScript = (script: string) => Promise<{ stdout: string; stderr: string }>;

export function mockHostExecutor(runScript: FakeRunScript): void {
  vi.doMock("../runtime/host.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime/host.js")>("../runtime/host.js");
    return { ...actual, hostExecutor: () => ({ kind: "local", label: "test", runScript, ptyCommand: vi.fn(), pipeCommand: vi.fn() }) };
  });
}

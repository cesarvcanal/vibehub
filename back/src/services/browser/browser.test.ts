import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The card's live browser. INVARIANTS the reviewers cared about:
 *  - no raw input ever reaches a shell: numbers are derived from the card id, the container name and
 *    the user-data-dir are always shQuoted;
 *  - RFB and CDP listen on 127.0.0.1 ONLY — the display is reachable through the docker exec bridge
 *    and nowhere else;
 *  - start is idempotent (a pgrep guard per link), so reopening the tab never doubles the processes;
 *  - stop kills ONLY that card's display/ports, never another card's browser;
 *  - a host-executor failure surfaces instead of being swallowed.
 *
 * The host executor and the board registry are mocked; `shQuote`/`assertSafeRemotePath` stay REAL,
 * because quoting is the property under test.
 */

const runScript = vi.fn();
const ptyCommand = vi.fn();

vi.mock("../../runtime/host.js", async (orig) => ({
  ...(await orig<typeof import("../../runtime/host.js")>()),
  hostExecutor: () => ({ kind: "local", label: "this machine", runScript, ptyCommand, writeFile: vi.fn() }),
}));
vi.mock("../board/registry.js", () => ({ getCard: vi.fn(), getProject: vi.fn() }));

const CARD = "1a2b3c4d-1111-2222-3333-444455556666";
const OTHER = "99887766-1111-2222-3333-444455556666";

async function load() {
  const mod = await import("./browser.js");
  const reg = await import("../board/registry.js");
  const { config } = await import("../../config/env.js");
  return { mod, reg, config };
}

const card = { id: CARD, projectId: "proj-1" } as never;
const project = { id: "proj-1", name: "api" } as never;

function wireOk(reg: Awaited<ReturnType<typeof load>>["reg"]) {
  vi.mocked(reg.getCard).mockResolvedValue(card);
  vi.mocked(reg.getProject).mockResolvedValue(project);
}

beforeEach(() => {
  vi.clearAllMocks();
  runScript.mockResolvedValue({ stdout: "vibehub-browser-up\n", stderr: "" });
  ptyCommand.mockImplementation((line: string) => ({ file: "bash", args: ["-lc", line] }));
});

describe("buildBrowserStartScript", () => {
  it("is idempotent, keeps RFB/CDP on loopback and passes everything through a heredoc", async () => {
    const { mod } = await load();
    const p = mod.cardBrowserPorts(CARD);
    const s = mod.buildBrowserStartScript({ containerName: "vibehub-runner", ...p });

    expect(s).toContain("docker exec -i 'vibehub-runner' bash -s <<'VIBEHUB_BROWSER_START'");
    expect(s.trimEnd().endsWith("VIBEHUB_BROWSER_START")).toBe(true);
    // idempotency: every link is guarded by a pgrep before setsid
    expect(s).toContain(`pgrep -f "Xvfb :${p.display} "`);
    expect(s).toContain(`pgrep -f "x11vnc -display :${p.display}`);
    expect(s).toContain(`pgrep -f "remote-debugging-port=${p.cdpPort}`);
    expect(s).toContain("setsid Xvfb");
    // loopback only
    expect(s).toContain(`-localhost -rfbport ${p.vncPort}`);
    expect(s).toContain("--remote-debugging-address=127.0.0.1");
    expect(s).toContain(`--remote-debugging-port=${p.cdpPort}`);
    expect(s).toContain("-nolisten tcp");
    // Playwright's chromium + a per-card, quoted user-data-dir
    expect(s).toContain("/root/.cache/ms-playwright/chromium-");
    expect(s).toContain(`--user-data-dir='${p.userDataDir}'`);
    // deliberately NO set -e: pgrep with no match exits non-zero and would abort the launcher
    expect(s).not.toContain("set -e");
  });

  it("produces byte-identical output for the same card (applying twice changes nothing)", async () => {
    const { mod } = await load();
    const p = mod.cardBrowserPorts(CARD);
    const once = mod.buildBrowserStartScript({ containerName: "vibehub-runner", ...p });
    const twice = mod.buildBrowserStartScript({ containerName: "vibehub-runner", ...p });
    expect(once).toBe(twice);
  });

  it("quotes a hostile container name into a single argument", async () => {
    const { mod } = await load();
    const p = mod.cardBrowserPorts(CARD);
    const s = mod.buildBrowserStartScript({ containerName: "run'; rm -rf / #", ...p });
    expect(s).toContain(`docker exec -i 'run'\\''; rm -rf / #' bash -s`);
    // the injected command never becomes a standalone statement
    expect(s).not.toMatch(/\n\s*rm -rf \//);
  });

  it("gives two cards non-overlapping displays and ports", async () => {
    const { mod } = await load();
    const a = mod.buildBrowserStartScript({ containerName: "c", ...mod.cardBrowserPorts(CARD) });
    const b = mod.buildBrowserStartScript({ containerName: "c", ...mod.cardBrowserPorts(OTHER) });
    const pa = mod.cardBrowserPorts(CARD);
    const pb = mod.cardBrowserPorts(OTHER);
    expect(a).toContain(`Xvfb :${pa.display} `);
    expect(b).toContain(`Xvfb :${pb.display} `);
    expect(a).not.toContain(`Xvfb :${pb.display} `);
    expect(b).not.toContain(`rfbport ${pa.vncPort}`);
  });
});

describe("buildBrowserStopScript", () => {
  it("kills only this card's processes", async () => {
    const { mod } = await load();
    const p = mod.cardBrowserPorts(CARD);
    const other = mod.cardBrowserPorts(OTHER);
    const s = mod.buildBrowserStopScript({ containerName: "vibehub-runner", ...p });
    expect(s).toContain(`pkill -f "remote-debugging-port=${p.cdpPort}`);
    expect(s).toContain(`pkill -f "x11vnc -display :${p.display}`);
    expect(s).toContain(`pkill -f "Xvfb :${p.display} "`);
    expect(s).toContain("<<'VIBEHUB_BROWSER_STOP'");
    // never touches the neighbour
    expect(s).not.toContain(String(other.cdpPort));
    expect(s).not.toContain(`Xvfb :${other.display} `);
    // every pkill tolerates "no such process" — stopping an already-stopped browser is not an error
    expect(s.match(/\|\| true/g)?.length).toBe(3);
  });
});

describe("the vnc bridge", () => {
  it("vncBridgeRemoteCommand: socat on the container loopback, container quoted", async () => {
    const { mod } = await load();
    expect(mod.vncBridgeRemoteCommand("vibehub-runner", 6404)).toBe(
      "docker exec -i 'vibehub-runner' socat STDIO TCP:127.0.0.1:6404",
    );
  });

  it("vncBridgeCommand: argv comes from the host executor, remote command LAST", async () => {
    const { mod } = await load();
    const cmd = mod.vncBridgeCommand("vibehub-runner", 6404);
    expect(cmd.file).toBe("bash");
    expect(cmd.args[cmd.args.length - 1]).toBe("docker exec -i 'vibehub-runner' socat STDIO TCP:127.0.0.1:6404");
    expect(ptyCommand).toHaveBeenCalledOnce();
  });
});

describe("resolveCardBrowser / open / close / cardVncBridge", () => {
  it("missing card -> clear error, nothing runs on the host", async () => {
    const { mod, reg } = await load();
    vi.mocked(reg.getCard).mockResolvedValue(undefined);
    await expect(mod.resolveCardBrowser(CARD)).rejects.toThrow("card not found");
    expect(runScript).not.toHaveBeenCalled();
  });

  it("missing project -> clear error, nothing runs on the host", async () => {
    const { mod, reg } = await load();
    vi.mocked(reg.getCard).mockResolvedValue(card);
    vi.mocked(reg.getProject).mockResolvedValue(undefined);
    await expect(mod.resolveCardBrowser(CARD)).rejects.toThrow(/project for this card/);
    expect(runScript).not.toHaveBeenCalled();
  });

  it("resolves to the single configured runner container", async () => {
    const { mod, reg, config } = await load();
    wireOk(reg);
    const r = await mod.resolveCardBrowser(CARD);
    expect(r.containerName).toBe(config.runner.container);
    expect(r.ports).toEqual(mod.cardBrowserPorts(CARD));
  });

  it("openCardBrowser runs the start script over stdin and returns the ports", async () => {
    const { mod, reg } = await load();
    wireOk(reg);
    const ports = await mod.openCardBrowser(CARD, "alice");
    expect(ports).toEqual(mod.cardBrowserPorts(CARD));
    expect(runScript).toHaveBeenCalledTimes(1);
    const [script, opts] = runScript.mock.calls[0]!;
    expect(script).toContain("<<'VIBEHUB_BROWSER_START'");
    expect(script).toContain(`--remote-debugging-port=${ports.cdpPort}`);
    expect(opts).toMatchObject({ timeoutMs: 60_000 });
  });

  it("opening twice sends the very same script (idempotent by construction)", async () => {
    const { mod, reg } = await load();
    wireOk(reg);
    await mod.openCardBrowser(CARD);
    await mod.openCardBrowser(CARD);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0]![0]).toBe(runScript.mock.calls[1]![0]);
  });

  it("closeCardBrowser runs the stop script", async () => {
    const { mod, reg } = await load();
    wireOk(reg);
    await mod.closeCardBrowser(CARD, "alice");
    expect(runScript.mock.calls[0]![0]).toContain("<<'VIBEHUB_BROWSER_STOP'");
  });

  it("cardVncBridge starts the browser first, then hands back argv + ports", async () => {
    const { mod, reg } = await load();
    wireOk(reg);
    const b = await mod.cardVncBridge(CARD, "alice");
    expect(runScript).toHaveBeenCalledTimes(1); // idempotent start before bridging
    expect(b.ports).toEqual(mod.cardBrowserPorts(CARD));
    expect(b.command.args[b.command.args.length - 1]).toContain(`TCP:127.0.0.1:${b.ports.vncPort}`);
  });

  it("a host-executor failure propagates (open must not report success)", async () => {
    const { mod, reg } = await load();
    wireOk(reg);
    runScript.mockRejectedValue(new Error("host command timed out"));
    await expect(mod.openCardBrowser(CARD)).rejects.toThrow("host command timed out");
    await expect(mod.closeCardBrowser(CARD)).rejects.toThrow("host command timed out");
    await expect(mod.cardVncBridge(CARD)).rejects.toThrow("host command timed out");
  });
});

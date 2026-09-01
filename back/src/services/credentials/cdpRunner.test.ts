import { describe, it, expect } from "vitest";
import { CDP_RUNNER_SOURCE } from "./cdpRunner.js";

/**
 * The CDP runner is a STRING (a Node program executed inside the runner container), so these tests
 * pin its invariants as source properties:
 *  - the injected observer both reports logins AND paints the click ripple (guided viewing), and
 *    installs itself exactly once per document;
 *  - the ripple can never interfere with the page: pointer-events none, closed shadow root, and it
 *    removes itself;
 *  - capture mode EXITS when the CDP socket dies, so a relaunched browser gets a fresh observer
 *    (capture and the ripple both come back on the next panel open);
 *  - the secret never appears anywhere near the ripple path.
 */
describe("CDP_RUNNER_SOURCE — click ripple (visualização guiada)", () => {
  it("listens for clicks in the capture phase and draws at the pointer position", () => {
    expect(CDP_RUNNER_SOURCE).toContain('w.addEventListener(\\"pointerdown\\"');
    expect(CDP_RUNNER_SOURCE).toContain("ripple(e.clientX, e.clientY)");
  });

  it("the ripple is inert for the page: pointer-events none, closed shadow root, self-removing", () => {
    expect(CDP_RUNNER_SOURCE).toContain("pointer-events:none");
    expect(CDP_RUNNER_SOURCE).toContain("z-index:2147483647");
    expect(CDP_RUNNER_SOURCE).toContain('mode: \\"closed\\"');
    expect(CDP_RUNNER_SOURCE).toContain("host.remove()");
  });

  it("the observer installs once per document (idempotent under re-injection)", () => {
    expect(CDP_RUNNER_SOURCE).toContain("if (w.__vibehubCaptureInstalled) return;");
    // and keeps being re-installed after top-frame navigations
    expect(CDP_RUNNER_SOURCE).toContain("Page.frameNavigated");
    expect(CDP_RUNNER_SOURCE).toContain("Page.addScriptToEvaluateOnNewDocument");
  });

  it("capture mode exits when the browser (socket) goes away, so a restart re-injects everything", () => {
    expect(CDP_RUNNER_SOURCE).toContain("ws.onclose = () => process.exit(0);");
    expect(CDP_RUNNER_SOURCE).toContain("if (handshaken && api.onclose) api.onclose();");
  });

  it("the ripple path never touches the captured values (no password/username reads in it)", () => {
    const rippleSrc = CDP_RUNNER_SOURCE.slice(
      CDP_RUNNER_SOURCE.indexOf("function ripple"),
      CDP_RUNNER_SOURCE.indexOf("w.addEventListener"),
    );
    expect(rippleSrc.length).toBeGreaterThan(0);
    expect(rippleSrc).not.toContain("password");
    expect(rippleSrc).not.toContain("value");
    expect(rippleSrc).not.toContain("__vibehubCapture(");
  });
});

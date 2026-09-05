import { describe, it, expect } from "vitest";
import { CDP_RUNNER_SOURCE } from "./cdpRunner.js";

/**
 * The CDP runner is a STRING (a Node program executed inside the runner container), so these tests
 * pin its invariants as source properties:
 *  - the injected observer reports logins AND paints what the agent is doing (guided viewing), and
 *    installs itself exactly once per document;
 *  - it paints a CURSOR, because CDP input never moves the X11 pointer: without a drawn one there
 *    is no mouse on the VNC canvas to follow, which is the whole reason this exists;
 *  - the overlay can never interfere with the page: pointer-events none, closed shadow root, and
 *    every mark removes itself;
 *  - it pings the back (throttled) so the card bar can say "this browser is busy";
 *  - capture mode EXITS when the CDP socket dies, so a relaunched browser gets a fresh observer
 *    (capture and the overlay both come back on the next panel open);
 *  - the secret never appears anywhere near the drawing path.
 */
describe("CDP_RUNNER_SOURCE — overlay do agente (visualização guiada)", () => {
  it("listens for clicks in the capture phase and draws at the pointer position", () => {
    expect(CDP_RUNNER_SOURCE).toContain('w.addEventListener(\\"pointerdown\\"');
    expect(CDP_RUNNER_SOURCE).toContain("ripple(e.clientX, e.clientY)");
  });

  it("follows the pointer too — a click ripple alone leaves the mouse invisible between clicks", () => {
    expect(CDP_RUNNER_SOURCE).toContain('w.addEventListener(\\"pointermove\\"');
    expect(CDP_RUNNER_SOURCE).toContain("moveCursor(e.clientX, e.clientY)");
    // …and says WHAT was clicked, not only where.
    expect(CDP_RUNNER_SOURCE).toContain("outline(e.target)");
  });

  it("tells the back the browser is busy, throttled — a pointer move fires dozens of times a second", () => {
    expect(CDP_RUNNER_SOURCE).toContain("if (now - lastPing < 400) return;");
    expect(CDP_RUNNER_SOURCE).toContain('JSON.stringify({ act: 1 })');
    expect(CDP_RUNNER_SOURCE).toContain('type: \"activity\"');
  });

  it("the overlay is inert for the page: pointer-events none, closed shadow root, self-removing", () => {
    expect(CDP_RUNNER_SOURCE).toContain("pointer-events:none");
    expect(CDP_RUNNER_SOURCE).toContain("z-index:2147483647");
    expect(CDP_RUNNER_SOURCE).toContain('mode: \\"closed\\"');
    expect(CDP_RUNNER_SOURCE).toContain("dot.remove()");
    expect(CDP_RUNNER_SOURCE).toContain("box.remove()");
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

  it("the drawing path never touches the captured values (no password/username reads in it)", () => {
    const drawSrc = CDP_RUNNER_SOURCE.slice(
      CDP_RUNNER_SOURCE.indexOf("function ripple"),
      CDP_RUNNER_SOURCE.indexOf("w.addEventListener"),
    );
    expect(drawSrc.length).toBeGreaterThan(0);
    expect(drawSrc).not.toContain("password");
    expect(drawSrc).not.toContain("value");
    expect(drawSrc).not.toContain("__vibehubCapture(");
  });
});

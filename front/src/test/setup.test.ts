import { describe, expect, it } from "vitest";
import { loadDraft, saveDraft } from "@/features/board/components/TerminalComposer";

/**
 * The global `afterEach` (./setup.ts) is what keeps one test from leaking into the next. The
 * composer's drafts live in a MODULE map on purpose — a half-written message survives the pane
 * unmounting — and a module outlives the test that wrote into it. Any file that mounts the
 * composer twice with the same card id (the card view, the board page, the chats) used to hand
 * the second test the first one's words. These two run in order: the second sees a clean slate
 * only because the setup forgot the first one's draft.
 */
describe("test setup — composer drafts do not leak between tests", () => {
  it("a test leaves a half-written draft behind", () => {
    saveDraft("c1", "rascunho de outro teste", []);
    expect(loadDraft("c1").text).toBe("rascunho de outro teste");
  });

  it("the next test starts without it", () => {
    expect(loadDraft("c1").text).toBe("");
  });
});

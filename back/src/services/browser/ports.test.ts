import { describe, it, expect } from "vitest";
import {
  cardBrowserSlot, cardBrowserPorts, cardCdpEndpoint,
  SLOT_SPACE, DISPLAY_BASE, VNC_PORT_BASE, CDP_PORT_BASE, BROWSER_DATA_DIR,
} from "./ports.js";

/**
 * Pure derivation of a card's display/ports. INVARIANTS:
 *  - deterministic (the same card must land on the same display forever, or reopening the tab would
 *    talk to a browser nobody is watching);
 *  - the three ranges never overlap, and every card's slot is shared by all three;
 *  - TOTAL: no input can make it throw, because this runs on the card-open path;
 *  - the user-data-dir can never carry a shell metacharacter — it is shQuoted downstream, but the
 *    charset is the real guarantee.
 */

const CARD = "1a2b3c4d-1111-2222-3333-444455556666";

describe("cardBrowserSlot", () => {
  it("is deterministic and inside the slot space", () => {
    expect(cardBrowserSlot(CARD)).toBe(cardBrowserSlot(CARD));
    expect(cardBrowserSlot(CARD)).toBeGreaterThanOrEqual(0);
    expect(cardBrowserSlot(CARD)).toBeLessThan(SLOT_SPACE);
  });

  it("sends different ids to different slots (normal path: leading hex)", () => {
    expect(cardBrowserSlot("1a2b3c4d-aaaa")).not.toBe(cardBrowserSlot("ffffffff-bbbb"));
  });

  it("never throws on a non-hex id — a weird id must not break opening a card", () => {
    for (const id of ["zzzzzz-nope", "", "  ", "../../etc/passwd", "'; rm -rf /", "ünïcødé", "-".repeat(50)]) {
      const s = cardBrowserSlot(id);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SLOT_SPACE);
      expect(s).toBe(cardBrowserSlot(id)); // still deterministic on the fallback path
    }
  });

  it("spreads uuids across the space instead of clumping (real allocation, not a constant)", () => {
    // The slot comes from the FIRST 6 hex chars, so the fixture has to vary exactly those — which is
    // what randomUUID() gives a real card.
    const slots = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const prefix = ((i * 2654435761) % 0xffffff).toString(16).padStart(6, "0");
      slots.add(cardBrowserSlot(`${prefix}ab-1111-2222-3333-444455556666`));
    }
    // 200 ids into 900 slots: a few birthday collisions are expected, a single bucket is not.
    expect(slots.size).toBeGreaterThan(150);
  });
});

describe("cardBrowserPorts", () => {
  it("keeps the three ranges disjoint and driven by one slot", () => {
    const a = cardBrowserPorts(CARD);
    expect(a).toEqual(cardBrowserPorts(CARD));
    expect(a.display).toBeGreaterThanOrEqual(DISPLAY_BASE);
    expect(a.display).toBeLessThan(DISPLAY_BASE + SLOT_SPACE);
    expect(a.vncPort).toBeGreaterThanOrEqual(VNC_PORT_BASE);
    expect(a.vncPort).toBeLessThan(VNC_PORT_BASE + SLOT_SPACE);
    expect(a.cdpPort).toBeGreaterThanOrEqual(CDP_PORT_BASE);
    expect(a.cdpPort).toBeLessThan(CDP_PORT_BASE + SLOT_SPACE);
    // one slot behind all three
    expect(a.display - DISPLAY_BASE).toBe(a.vncPort - VNC_PORT_BASE);
    expect(a.display - DISPLAY_BASE).toBe(a.cdpPort - CDP_PORT_BASE);
  });

  it("never lets the vnc range reach into the cdp range", () => {
    expect(VNC_PORT_BASE + SLOT_SPACE).toBeLessThanOrEqual(CDP_PORT_BASE);
  });

  it("two different cards get different displays AND different ports", () => {
    const a = cardBrowserPorts("1a2b3c4d-1111-2222-3333-444455556666");
    const b = cardBrowserPorts("99887766-1111-2222-3333-444455556666");
    expect(a.display).not.toBe(b.display);
    expect(a.vncPort).not.toBe(b.vncPort);
    expect(a.cdpPort).not.toBe(b.cdpPort);
    expect(a.userDataDir).not.toBe(b.userDataDir);
  });

  it("derives the user-data-dir under the runner's persistent /work mount", () => {
    expect(cardBrowserPorts(CARD).userDataDir).toBe(`${BROWSER_DATA_DIR}/card-1a2b3c4d`);
  });

  it("strips every shell metacharacter out of the user-data-dir", () => {
    for (const id of ["'; rm -rf / #", "$(whoami)", "a b\nc", "../../root", "`id`"]) {
      const { userDataDir } = cardBrowserPorts(id);
      expect(userDataDir).toMatch(/^\/work\/\.browser\/card-[0-9a-zA-Z]*$/);
      expect(userDataDir).not.toContain("..");
    }
  });
});

describe("cardCdpEndpoint", () => {
  it("is loopback-only and matches the derived cdp port", () => {
    expect(cardCdpEndpoint(CARD)).toBe(`http://127.0.0.1:${cardBrowserPorts(CARD).cdpPort}`);
  });
});

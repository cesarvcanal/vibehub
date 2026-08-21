/**
 * Minimal typings for `@novnc/novnc`, which ships plain ESM with no declarations.
 *
 * Only what the card browser actually uses is described — a fuller surface would be guesswork, and
 * guessed types are worse than none.
 */
declare module "@novnc/novnc" {
  export interface RFBOptions {
    /** Sub-protocols to request. vibehub's bridge speaks raw RFB, so this is `[]`. */
    wsProtocols?: string[];
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}

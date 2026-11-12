import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CLEARED_NOTE,
  SDK_ERROR_NO_DETAIL,
  SDK_ERROR_TURN_FAILED,
  TERMINAL_ACTIVITY_NOTE,
  TURN_INTERRUPTED_EDIT_NOTE,
  TURN_INTERRUPTED_NOTE,
  cancelledText,
  errorText,
  noteText,
} from "@/features/board/lib/sdkChat";
import type { Translate } from "@/i18n";

/** Echoes the key and its vars, so each case asserts WHICH sentence was picked and with what. */
const echo: Translate = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

describe("cancelledText", () => {
  it("names who stopped the turn, per how it was stopped", () => {
    expect(cancelledText({ how: "stop", by: "ana" }, echo)).toBe('sdk.questionCancelled.stop {"name":"Ana"}');
  });

  it("without a name, the anonymous sentence; without a cancel, a stop", () => {
    expect(cancelledText({ how: "stop" }, echo)).toBe("sdk.questionCancelled.stop.anon");
    expect(cancelledText(undefined, echo)).toBe("sdk.questionCancelled.stop.anon");
  });
});

describe("noteText", () => {
  it("translates the coded notes", () => {
    expect(noteText(TERMINAL_ACTIVITY_NOTE, echo)).toBe("sdk.terminalActivity");
    expect(noteText(TURN_INTERRUPTED_EDIT_NOTE, echo)).toBe("sdk.noteInterruptedEdit");
    expect(noteText(TURN_INTERRUPTED_NOTE, echo)).toBe("sdk.noteInterrupted");
    expect(noteText(CONVERSATION_CLEARED_NOTE, echo)).toBe("sdk.noteConversationCleared");
  });

  it("passes a sentence through", () => {
    expect(noteText("Plano aprovado", echo)).toBe("Plano aprovado");
  });
});

describe("errorText", () => {
  it("turns the reducer's sentinels into sentences", () => {
    expect(errorText(SDK_ERROR_NO_DETAIL, echo)).toBe("sdk.errorNoDetail");
    expect(errorText(SDK_ERROR_TURN_FAILED, echo)).toBe("sdk.turnFailed");
    expect(errorText(`${SDK_ERROR_TURN_FAILED}:error_max_turns`, echo)).toBe('sdk.turnFailedWhy {"subtype":"error_max_turns"}');
  });

  it("explains the known refusals", () => {
    expect(errorText("the sdkDriver setting is off", echo)).toBe("sdk.flagOff");
    expect(errorText("driver exited (code 1)", echo)).toBe('sdk.driverGone {"detail":"driver exited (code 1)"}');
    expect(errorText("could not install the driver: x", echo)).toBe('sdk.driverInstallFailed {"detail":"could not install the driver: x"}');
    expect(errorText("This card no longer exists", echo)).toBe("sdk.cardGone");
  });

  it("passes a sentence from the driver through", () => {
    expect(errorText("Rate limited, try later", echo)).toBe("Rate limited, try later");
  });
});

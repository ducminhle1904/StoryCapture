import { describe, expect, it } from "vitest";
import {
  CURSOR_COMMAND_POLICIES,
  cursorCommandPolicy,
  resolveCursorCommandPolicy,
  resolveRecordingIncludeCursor,
} from "./cursor-policy";
import type { ParsedCommandVerb } from "./story-parser";

const verbs = [
  "navigate",
  "click",
  "hover",
  "assert",
  "assert-visible",
  "type",
  "select",
  "upload",
  "drag",
  "scroll",
  "wait",
  "text-overlay",
  "wait-for",
  "wait-for-visible",
  "screenshot",
  "pause",
] as const satisfies readonly ParsedCommandVerb[];

describe("cursor command policy", () => {
  it("has one closed policy entry for every parsed command verb", () => {
    expect(Object.keys(CURSOR_COMMAND_POLICIES).sort()).toEqual([...verbs].sort());
  });

  it.each(verbs)("resolves both cursor toggle values for %s", (verb) => {
    const base = cursorCommandPolicy(verb);
    const enabled = resolveCursorCommandPolicy(verb, true);
    const disabled = resolveCursorCommandPolicy(verb, false);

    expect(enabled.contributesActionEvent).toBe(base.contributesActionEvent);
    expect(disabled.contributesActionEvent).toBe(base.contributesActionEvent);
    expect(enabled.emitVisibleTrajectory).toBe(base.visibleTrajectory);
    expect(enabled.applyCursorPacing).toBe(base.cursorOnlyPacing);
    expect(disabled.emitVisibleTrajectory).toBe(false);
    expect(disabled.applyCursorPacing).toBe(false);
    expect(disabled.requiredInputLandmarks).toEqual(base.requiredInputLandmarks);
    expect(disabled.presentation).toBe(base.presentation);
  });

  it("keeps the locked semantic classifications", () => {
    expect(cursorCommandPolicy("click").requiredInputLandmarks).toEqual(["down", "up", "action"]);
    expect(cursorCommandPolicy("hover").requiredInputLandmarks).toEqual(["action"]);
    expect(cursorCommandPolicy("type").delivery).toBe("virtual_only");
    expect(cursorCommandPolicy("select").presentation).toBe("required");
    expect(cursorCommandPolicy("upload").contributesActionEvent).toBe(true);
    expect(cursorCommandPolicy("drag").contributesActionEvent).toBe(true);
    expect(cursorCommandPolicy("scroll").contributesActionEvent).toBe(false);
  });

  it("freezes an explicit toggle and preserves the legacy host default", () => {
    expect(resolveRecordingIncludeCursor(false)).toBe(false);
    expect(resolveRecordingIncludeCursor(true)).toBe(true);
    expect(resolveRecordingIncludeCursor(undefined)).toBe(true);
    expect(resolveRecordingIncludeCursor(null, false)).toBe(false);
  });

  it("fails closed for an unknown runtime verb", () => {
    expect(() => cursorCommandPolicy("unknown" as ParsedCommandVerb)).toThrow(
      "cursor_policy_missing:unknown",
    );
  });
});

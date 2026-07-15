import type { ParsedCommandVerb } from "./story-parser";

export type CursorPresentationPolicy = "required" | "not_applicable";

export interface CursorCommandPolicy {
  contributesActionEvent: boolean;
  delivery: "browser_injected" | "virtual_only";
  visibleTrajectory: boolean;
  cursorOnlyPacing: boolean;
  requiredInputLandmarks: readonly ("action" | "down" | "up" | "text_start" | "text_end")[];
  presentation: CursorPresentationPolicy;
}

export interface ResolvedCursorCommandPolicy extends CursorCommandPolicy {
  includeCursor: boolean;
  emitVisibleTrajectory: boolean;
  applyCursorPacing: boolean;
}

const NO_CURSOR_EVENT = {
  contributesActionEvent: false,
  delivery: "virtual_only",
  visibleTrajectory: false,
  cursorOnlyPacing: false,
  requiredInputLandmarks: [],
  presentation: "not_applicable",
} as const satisfies CursorCommandPolicy;

export const CURSOR_COMMAND_POLICIES = {
  navigate: NO_CURSOR_EVENT,
  click: {
    contributesActionEvent: true,
    delivery: "browser_injected",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["down", "up", "action"],
    presentation: "required",
  },
  hover: {
    contributesActionEvent: true,
    delivery: "browser_injected",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["action"],
    presentation: "required",
  },
  assert: NO_CURSOR_EVENT,
  "assert-visible": NO_CURSOR_EVENT,
  type: {
    contributesActionEvent: true,
    delivery: "virtual_only",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["down", "up", "text_start", "text_end", "action"],
    presentation: "required",
  },
  select: {
    contributesActionEvent: true,
    delivery: "virtual_only",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["down", "up", "text_start", "text_end", "action"],
    presentation: "required",
  },
  upload: {
    contributesActionEvent: true,
    delivery: "virtual_only",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["action"],
    presentation: "required",
  },
  drag: {
    contributesActionEvent: true,
    delivery: "browser_injected",
    visibleTrajectory: true,
    cursorOnlyPacing: true,
    requiredInputLandmarks: ["down", "up", "action"],
    presentation: "required",
  },
  scroll: NO_CURSOR_EVENT,
  wait: NO_CURSOR_EVENT,
  "text-overlay": NO_CURSOR_EVENT,
  "wait-for": NO_CURSOR_EVENT,
  "wait-for-visible": NO_CURSOR_EVENT,
  screenshot: NO_CURSOR_EVENT,
  pause: NO_CURSOR_EVENT,
} as const satisfies Record<ParsedCommandVerb, CursorCommandPolicy>;

export function resolveRecordingIncludeCursor(
  explicitValue: unknown,
  legacyDefault = true,
): boolean {
  return typeof explicitValue === "boolean" ? explicitValue : legacyDefault;
}

export function cursorCommandPolicy(verb: ParsedCommandVerb): CursorCommandPolicy {
  const policy = CURSOR_COMMAND_POLICIES[verb];
  if (!policy) {
    const error = new Error(`cursor_policy_missing:${String(verb)}`);
    Object.assign(error, { recordingReasonCode: "cursor_policy_missing" });
    throw error;
  }
  return policy;
}

export function resolveCursorCommandPolicy(
  verb: ParsedCommandVerb,
  includeCursor: boolean,
): ResolvedCursorCommandPolicy {
  const policy = cursorCommandPolicy(verb);
  return {
    ...policy,
    includeCursor,
    emitVisibleTrajectory: includeCursor && policy.visibleTrajectory,
    applyCursorPacing: includeCursor && policy.cursorOnlyPacing,
  };
}

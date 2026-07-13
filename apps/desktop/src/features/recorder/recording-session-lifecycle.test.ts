import { describe, expect, it } from "vitest";

import { canFinalizeOwnedRecording } from "./recording-session-lifecycle";

describe("recording session finalization ownership", () => {
  it("accepts the active session before it has completed", () => {
    expect(
      canFinalizeOwnedRecording({
        ownerSessionId: "take-1",
        activeSessionId: "take-1",
        completedSessionId: null,
      }),
    ).toBe(true);
  });

  it("rejects duplicate completion for the same session", () => {
    expect(
      canFinalizeOwnedRecording({
        ownerSessionId: "take-1",
        activeSessionId: "take-1",
        completedSessionId: "take-1",
      }),
    ).toBe(false);
  });

  it("rejects stale completion from an older take", () => {
    expect(
      canFinalizeOwnedRecording({
        ownerSessionId: "take-1",
        activeSessionId: "take-2",
        completedSessionId: null,
      }),
    ).toBe(false);
  });
});

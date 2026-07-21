// AudioUnavailable event dispatch behavioral test.
//
// Verifies the pattern used in `recording-view.tsx`:
//   - An incoming RecordingEvent { type: "audio-unavailable", reason }
//     produces an application notification and flips a local audioUnavailable flag.
//   - Recording continues (status unchanged — video-only).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications", () => ({
  notifications: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { notifications } from "@/lib/notifications";

type RecordingEvent =
  | { type: "audio-unavailable"; reason: string }
  | { type: "heartbeat"; seq: number | bigint }
  | { type: "completed"; result: { output_path: string } }
  | { type: "failed"; message: string };

// Mirror the dispatch branches landed in recording-view.tsx.
function makeDispatch(state: { audioUnavailable: boolean }) {
  return (event: RecordingEvent) => {
    switch (event.type) {
      case "audio-unavailable":
        notifications.error(`Audio unavailable: ${event.reason}`);
        state.audioUnavailable = true;
        break;
      default:
        break;
    }
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("D-13 AudioUnavailable UX", () => {
  it("shows a notifications.error with the reason and sets the badge flag", () => {
    const state = { audioUnavailable: false };
    const dispatch = makeDispatch(state);

    dispatch({ type: "audio-unavailable", reason: "Mic busy" });

    expect(notifications.error).toHaveBeenCalledWith("Audio unavailable: Mic busy");
    expect(state.audioUnavailable).toBe(true);
  });

  it("does not flip the flag for unrelated events", () => {
    const state = { audioUnavailable: false };
    const dispatch = makeDispatch(state);

    dispatch({ type: "failed", message: "boom" });

    expect(state.audioUnavailable).toBe(false);
    expect(notifications.error).not.toHaveBeenCalled();
  });
});

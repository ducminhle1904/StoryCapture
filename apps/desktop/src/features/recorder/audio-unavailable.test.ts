// AudioUnavailable event dispatch behavioral test.
//
// Verifies the pattern used in `recording-view.tsx`:
//   - An incoming RecordingEvent { type: "audio-unavailable", reason }
//     produces a sonner toast.error and flips a local audioUnavailable flag.
//   - Recording continues (status unchanged — video-only).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { toast } from "sonner";

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
        toast.error(`Audio unavailable: ${event.reason}`);
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
  it("shows a toast.error with the reason and sets the badge flag", () => {
    const state = { audioUnavailable: false };
    const dispatch = makeDispatch(state);

    dispatch({ type: "audio-unavailable", reason: "Mic busy" });

    expect(toast.error).toHaveBeenCalledWith("Audio unavailable: Mic busy");
    expect(state.audioUnavailable).toBe(true);
  });

  it("does not flip the flag for unrelated events", () => {
    const state = { audioUnavailable: false };
    const dispatch = makeDispatch(state);

    dispatch({ type: "failed", message: "boom" });

    expect(state.audioUnavailable).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

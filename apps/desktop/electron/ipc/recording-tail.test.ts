import { describe, expect, it } from "vitest";

import { recordingFrameCountForElapsedMs, recordingTailFrameDelaysMs } from "./recording-tail";

describe("recording automation tail", () => {
  it("splits the automation tail into bounded final frame delays", () => {
    expect(recordingTailFrameDelaysMs()).toEqual([300, 300, 300, 300]);
    expect(recordingTailFrameDelaysMs(750, 3)).toEqual([250, 250, 250]);
  });

  it("disables invalid tail schedules", () => {
    expect(recordingTailFrameDelaysMs(0, 2)).toEqual([]);
    expect(recordingTailFrameDelaysMs(500, 0)).toEqual([]);
  });

  it("rounds elapsed recording time up to the frame count needed at fps", () => {
    expect(recordingFrameCountForElapsedMs(3974, 60)).toBe(239);
    expect(recordingFrameCountForElapsedMs(0, 60)).toBe(0);
    expect(recordingFrameCountForElapsedMs(1000, 0)).toBe(0);
  });
});

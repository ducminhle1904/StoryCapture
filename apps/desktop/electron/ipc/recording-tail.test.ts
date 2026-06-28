import { describe, expect, it } from "vitest";

import {
  recordingTailFrameDelaysMs,
} from "./recording-tail";

describe("recording automation tail", () => {
  it("splits the automation tail into bounded final frame delays", () => {
    expect(recordingTailFrameDelaysMs()).toEqual([250, 250]);
    expect(recordingTailFrameDelaysMs(750, 3)).toEqual([250, 250, 250]);
  });

  it("disables invalid tail schedules", () => {
    expect(recordingTailFrameDelaysMs(0, 2)).toEqual([]);
    expect(recordingTailFrameDelaysMs(500, 0)).toEqual([]);
  });
});

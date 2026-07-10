import { describe, expect, it } from "vitest";

import { RecordingMediaClock, recordingFramePtsUs } from "./recording-media-clock";

describe("recording media clock", () => {
  it.each([
    { fpsNum: 24, fpsDen: 1, expected: 41_667 },
    { fpsNum: 30, fpsDen: 1, expected: 33_333 },
    { fpsNum: 60, fpsDen: 1, expected: 16_667 },
    { fpsNum: 30_000, fpsDen: 1_001, expected: 33_367 },
  ])("converts frame indexes at $fpsNum/$fpsDen fps", (frameRate) => {
    expect(recordingFramePtsUs(1, frameRate)).toBe(frameRate.expected);
  });

  it("commits only sink-acknowledged frames", () => {
    const clock = new RecordingMediaClock({ fpsNum: 60, fpsDen: 1 });

    expect(clock.commitFrame(false)).toBeNull();
    expect(clock.commitFrame(true)).toEqual({ frameIndex: 0, ptsUs: 0 });
    expect(clock.commitFrame(true)).toEqual({ frameIndex: 1, ptsUs: 16_667 });
    expect(clock.snapshot()).toMatchObject({
      frameCount: 2,
      durationUs: 33_333,
      nextFrameIndex: 2,
      nextPtsUs: 33_333,
    });
  });

  it("does not advance while paused and rejects commits after freeze", () => {
    const clock = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });
    clock.commitFrame(true);
    clock.pause();

    expect(() => clock.commitFrame(true)).toThrow("media clock is paused");
    expect(clock.snapshot().frameCount).toBe(1);

    clock.resume();
    clock.commitFrame(true);
    expect(clock.freeze()).toMatchObject({ frameCount: 2, state: "frozen" });
    expect(() => clock.commitFrame(true)).toThrow("media clock is frozen");
  });

  it("stays within one frame over a ten-minute rational-FPS recording", () => {
    const frameRate = { fpsNum: 30_000, fpsDen: 1_001 };
    const frameCount = Math.round((600 * frameRate.fpsNum) / frameRate.fpsDen);
    const durationUs = recordingFramePtsUs(frameCount, frameRate);

    expect(Math.abs(durationUs - 600_000_000)).toBeLessThanOrEqual(
      recordingFramePtsUs(1, frameRate),
    );
  });

  it("validates rational frame rates and frame indexes", () => {
    expect(() => new RecordingMediaClock({ fpsNum: 0, fpsDen: 1 })).toThrow("fpsNum");
    expect(() => recordingFramePtsUs(-1, { fpsNum: 60, fpsDen: 1 })).toThrow("frameIndex");
  });
});

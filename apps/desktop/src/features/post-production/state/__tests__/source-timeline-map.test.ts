import { describe, expect, it } from "vitest";
import {
  identitySourceTimelineMap,
  insertSourceHolds,
  isIdentitySourceTimelineMap,
  type SourceTimelineMap,
  sourcePtsUsToTimelineMs,
  timelineMsToSourcePtsUs,
} from "../source-timeline-map";

describe("source timeline map", () => {
  it("round-trips an identity map", () => {
    const map = identitySourceTimelineMap(2_000);
    expect(isIdentitySourceTimelineMap(map)).toBe(true);
    expect(timelineMsToSourcePtsUs(map, 1_234)).toBe(1_234_000);
    expect(sourcePtsUsToTimelineMs(map, 1_234_000)).toBe(1_234);
  });

  it("freezes source PTS through a hold segment", () => {
    const map: SourceTimelineMap = {
      version: 1,
      segments: [
        {
          kind: "media",
          sourceStartUs: 0,
          sourceEndUs: 1_000_000,
          timelineStartMs: 0,
          timelineEndMs: 1_000,
        },
        { kind: "hold", sourcePtsUs: 1_000_000, timelineStartMs: 1_000, timelineEndMs: 1_500 },
        {
          kind: "media",
          sourceStartUs: 1_000_000,
          sourceEndUs: 2_000_000,
          timelineStartMs: 1_500,
          timelineEndMs: 2_500,
        },
      ],
    };
    expect(timelineMsToSourcePtsUs(map, 1_250)).toBe(1_000_000);
    expect(timelineMsToSourcePtsUs(map, 2_000)).toBe(1_500_000);
    expect(isIdentitySourceTimelineMap(map)).toBe(false);
  });

  it("returns null outside mapped media", () => {
    const map = identitySourceTimelineMap(100);
    expect(timelineMsToSourcePtsUs(map, 101)).toBeNull();
    expect(sourcePtsUsToTimelineMs(map, 101_000)).toBeNull();
  });

  it("inserts an exact microsecond deficit without changing source duration", () => {
    const map = insertSourceHolds(identitySourceTimelineMap(1_000), [
      { sourcePtsUs: 400_000, durationUs: 123_456 },
    ]);
    expect(timelineMsToSourcePtsUs(map, 450)).toBe(400_000);
    expect(map.segments.at(-1)?.timelineEndMs).toBeCloseTo(1_123.456, 6);
    expect(
      map.segments
        .filter((segment) => segment.kind === "hold")
        .reduce((sum, segment) => sum + segment.timelineEndMs - segment.timelineStartMs, 0),
    ).toBeCloseTo(123.456, 6);
  });
});

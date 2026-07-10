import { describe, expect, it } from "vitest";
import { identitySourceTimelineMap, type SourceTimelineMap } from "../../state/source-timeline-map";
import { PresentedMediaClock, serializePresentedMediaState } from "../presented-media-clock";

describe("PresentedMediaClock", () => {
  it("does not advance while the decoder has not presented a new frame", () => {
    const clock = new PresentedMediaClock(identitySourceTimelineMap(2_000));
    clock.commitPresentedFrame(100_000);
    expect(clock.snapshot()?.timelineMs).toBe(100);
    expect(clock.snapshot()?.timelineMs).toBe(100);
  });

  it("rejects pre-seek callbacks until the new generation presents", () => {
    const clock = new PresentedMediaClock(identitySourceTimelineMap(2_000));
    const oldGeneration = clock.beginDiscontinuity();
    const newGeneration = clock.beginDiscontinuity();
    expect(clock.commitPresentedFrame(500_000, oldGeneration)).toBeNull();
    expect(clock.commitPresentedFrame(1_000_000, newGeneration)?.timelineMs).toBe(1_000);
  });

  it("advances timeline while holding a fixed source PTS", () => {
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
      ],
    };
    const clock = new PresentedMediaClock(map);
    clock.commitPresentedFrame(1_000_000);
    expect(clock.commitHold(1_400)).toMatchObject({ timelineMs: 1_400, sourcePtsUs: 1_000_000 });
    expect(serializePresentedMediaState(clock.snapshot())).toBe(
      '{"generation":0,"mode":"hold","source_pts_us":1000000,"timeline_ms":1400}',
    );
  });
});

import { describe, expect, it } from "vitest";
import explicitV2 from "@/ipc/__fixtures__/action-sidecars/v2-explicit-timing.actions.json";
import { parseActionSidecar } from "@/ipc/action-sidecar";
import {
  identitySourceTimelineMap,
  insertSourceHolds,
  timelineMsToSourcePtsUs,
} from "../../state/source-timeline-map";
import { buildVirtualCursorSchedule } from "../../state/virtual-cursor-scheduler";
import { PresentedMediaClock } from "../presented-media-clock";

describe("preview/export source-bound parity", () => {
  it("resolves identical source PTS at action boundaries and holds", () => {
    const map = insertSourceHolds(identitySourceTimelineMap(3_000), [
      { sourcePtsUs: 1_200_000, durationUs: 250_000 },
    ]);
    const previewClock = new PresentedMediaClock(map);
    for (const timelineMs of [0, 1_199, 1_300, 1_450, 2_000]) {
      const exportPts = timelineMsToSourcePtsUs(map, timelineMs);
      expect(exportPts).not.toBeNull();
      if (timelineMs >= 1_200 && timelineMs <= 1_450) {
        previewClock.commitPresentedFrame(1_200_000);
        expect(previewClock.commitHold(timelineMs)?.sourcePtsUs).toBe(exportPts);
      } else if (exportPts != null) {
        expect(previewClock.commitPresentedFrame(exportPts)?.sourcePtsUs).toBe(exportPts);
      }
    }
  });

  it("never emits cursor travel after the encoded input boundary", () => {
    const actions = parseActionSidecar(explicitV2);
    const schedule = buildVirtualCursorSchedule(actions, "cinematic");
    expect(schedule).not.toBeNull();
    expect(
      schedule?.segments.every(
        (segment) =>
          segment.arrivalMs <=
          (segment.event.input_landmarks?.action?.pts_us != null
            ? segment.event.input_landmarks.action.pts_us / 1000
            : (segment.event.input_timing?.action_ms ?? segment.event.t_action_ms)),
      ),
    ).toBe(true);
  });
});

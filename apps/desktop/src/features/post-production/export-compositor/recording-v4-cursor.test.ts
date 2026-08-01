import type {
  RecordingV4ActionSidecar,
  RecordingV4CursorSidecar,
} from "@storycapture/shared-types/recording-v4";
import { describe, expect, it } from "vitest";

import { prepareRecordingV4Cursor, sampleRecordingV4Cursor } from "./recording-v4-cursor";

const actions: RecordingV4ActionSidecar = {
  version: 4,
  session_id: "session-v4",
  clock: "active_media_time_us",
  events: [
    {
      step_id: "buy",
      ordinal: 1,
      phase: "succeeded",
      verb: "click",
      target: { selector: "#buy", bounds: { x: 576, y: 324, width: 128, height: 72 } },
      timing: {
        started_us: 800_000,
        action_us: 1_000_000,
        ended_us: 1_100_000,
        input_us: { down: 990_000, up: 1_010_000 },
        presented_us: 1_050_000,
      },
      error_message: null,
      active_media_time_us: 1_100_000,
    },
  ],
};

function cursor(samples: RecordingV4CursorSidecar["samples"]): RecordingV4CursorSidecar {
  return {
    version: 4,
    session_id: "session-v4",
    clock: "active_media_time_us",
    geometry: {
      coordinate_width: 1280,
      coordinate_height: 720,
      capture_width: 1920,
      capture_height: 1080,
    },
    samples,
  };
}

describe("Recording V4 canonical cursor sampling", () => {
  it("uses deterministic neighboring-sample interpolation and holds the final dwell", () => {
    const runtime = prepareRecordingV4Cursor(
      actions,
      cursor([
        { active_media_time_us: 0, x: 0.1, y: 0.2, kind: "pointer", visible: true, pressed: false },
        {
          active_media_time_us: 1_000_000,
          x: 0.9,
          y: 0.6,
          kind: "text",
          visible: true,
          pressed: false,
        },
      ]),
    );

    expect(sampleRecordingV4Cursor(runtime, 500_000)).toMatchObject({
      x: 0.5,
      y: 0.4,
      kind: "pointer",
      visible: true,
      pressed: false,
    });
    expect(sampleRecordingV4Cursor(runtime, 2_000_000)).toMatchObject({
      x: 0.9,
      y: 0.6,
      kind: "text",
    });
  });

  it("keeps explicit visibility and click state while applying the selected click preset", () => {
    const runtime = prepareRecordingV4Cursor(
      actions,
      cursor([
        {
          active_media_time_us: 0,
          x: 0.2,
          y: 0.3,
          kind: "default",
          visible: false,
          pressed: false,
        },
        {
          active_media_time_us: 900_000,
          x: 0.5,
          y: 0.5,
          kind: "pointer",
          visible: true,
          pressed: true,
        },
        {
          active_media_time_us: 1_100_000,
          x: 0.5,
          y: 0.5,
          kind: "pointer",
          visible: true,
          pressed: false,
        },
      ]),
    );

    expect(sampleRecordingV4Cursor(runtime, 100_000)?.visible).toBe(false);
    const click = sampleRecordingV4Cursor(runtime, 1_050_000, {
      style: "ring",
      color: "brand",
      intensity: "strong",
    });
    expect(click).toMatchObject({ kind: "pointer", visible: true, pressed: true });
    expect(click?.clickFeedback.length).toBeGreaterThan(0);
  });

  it("uses action semantics for click feedback when optional press samples are missing", () => {
    const runtime = prepareRecordingV4Cursor(
      actions,
      cursor([
        {
          active_media_time_us: 0,
          x: 0.25,
          y: 0.25,
          kind: "default",
          visible: true,
          pressed: false,
        },
        {
          active_media_time_us: 2_000_000,
          x: 0.75,
          y: 0.75,
          kind: "default",
          visible: true,
          pressed: false,
        },
      ]),
    );
    expect(
      sampleRecordingV4Cursor(runtime, 1_100_000, {
        style: "soft-pulse",
        color: "auto",
        intensity: "normal",
      })?.clickFeedback,
    ).not.toHaveLength(0);
  });

  it("fails closed when no cursor samples exist", () => {
    expect(sampleRecordingV4Cursor(prepareRecordingV4Cursor(actions, cursor([])), 0)).toBeNull();
  });
});

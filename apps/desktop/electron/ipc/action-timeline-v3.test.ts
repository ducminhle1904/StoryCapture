import { describe, expect, it } from "vitest";
import {
  type ActionTimelineEvent,
  type RecordingActions,
  RecordingActionsV3ValidationError,
  validateRecordingActionsV3,
} from "./action-timeline";

function clickEvent(overrides: Partial<ActionTimelineEvent> = {}): ActionTimelineEvent {
  return {
    policy_version: 1,
    include_cursor: true,
    step_id: "step-click",
    ordinal: 1,
    verb: "click",
    t_start_ms: 0,
    t_action_ms: 2,
    t_end_ms: 3,
    target: null,
    secondary_target: null,
    pointer: { button: "left", effect: "click" },
    cursor_path: {
      interpolation: "media-frame-linear-v1",
      samples: [{ frame_index: 0, pts_us: 0, x: 10, y: 20 }],
      arrival: { frame_index: 1, pts_us: 1_000 },
    },
    input_landmarks: {
      down: { frame_index: 1, pts_us: 1_000 },
      up: { frame_index: 2, pts_us: 2_000 },
      action: { frame_index: 2, pts_us: 2_000 },
    },
    presentation: {
      status: "presented",
      first_post_input_frame: { frame_index: 3, pts_us: 3_000 },
    },
    ...overrides,
  };
}

function actions(events: ActionTimelineEvent[]): RecordingActions {
  return {
    version: 3,
    recording_path: "exports/takes/take-1/video.mp4",
    viewport: { width: 1280, height: 720 },
    capture_rect: { x: 0, y: 0, width: 1280, height: 720 },
    fps: 30,
    frame_count: 4,
    media_clock: {
      clock: "encoded_video_pts",
      unit: "us",
      fps_num: 30,
      fps_den: 1,
      origin_frame: 0,
      frame_count: 4,
      duration_us: 133_333,
    },
    events,
  };
}

describe("recording action sidecar v3 validation", () => {
  it("accepts a valid strict event and an empty zero-interaction recording", () => {
    expect(() =>
      validateRecordingActionsV3(actions([clickEvent()]), { requirePresented: true }),
    ).not.toThrow();
    expect(() => validateRecordingActionsV3(actions([]), { requirePresented: true })).not.toThrow();
  });

  it("accepts cursor-disabled events only when visible samples and pacing are absent", () => {
    const disabled = clickEvent({
      include_cursor: false,
      cursor_path: {
        interpolation: "media-frame-linear-v1",
        samples: [],
        arrival: { frame_index: 1, pts_us: 1_000 },
      },
    });
    expect(() =>
      validateRecordingActionsV3(actions([disabled]), { requirePresented: true }),
    ).not.toThrow();
    expect(() =>
      validateRecordingActionsV3(
        actions([
          {
            ...disabled,
            cursor_timing: {
              motion_preset: "natural",
              start_ms: 0,
              arrival_ms: 1,
              travel_ms: 1,
              dwell_ms: 0,
            },
          },
        ]),
      ),
    ).toThrow("cursor_timing_disabled");
  });

  it("rejects missing landmarks, duplicate IDs, invalid ordering, and unproven presentation", () => {
    const invalid = actions([
      clickEvent({
        input_landmarks: {
          down: { frame_index: 2, pts_us: 4_000 },
          action: { frame_index: 2, pts_us: 500 },
        },
        presentation: { status: "timeout", diagnostic_reason: "post_input_frame_timeout" },
      }),
      clickEvent({ ordinal: 2 }),
    ]);

    try {
      validateRecordingActionsV3(invalid, { requirePresented: true });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingActionsV3ValidationError);
      const issues = (error as RecordingActionsV3ValidationError).issues;
      expect(issues).toEqual(
        expect.arrayContaining([
          "event_1_up_missing",
          "event_1_arrival_after_action",
          "event_1_presentation_not_proven",
          "event_2_duplicate_id",
        ]),
      );
    }
  });

  it("validates drag gesture samples and both endpoint provenance records", () => {
    const drag = clickEvent({
      step_id: "step-drag",
      verb: "drag",
      pointer: { button: "left", effect: "drag" },
      gesture: {
        kind: "drag",
        source: { x: 10, y: 20 },
        destination: { x: 300, y: 220 },
        samples: [
          { x: 100, y: 80, elapsed_ms: 33 },
          { x: 300, y: 220, elapsed_ms: 66 },
        ],
        source_match: { source: "story_target", fallback_index: null },
        destination_match: { source: "sidecar_fallback", fallback_index: 0 },
      },
    });
    expect(() =>
      validateRecordingActionsV3(actions([drag]), { requirePresented: true }),
    ).not.toThrow();
  });

  it("validates privacy-safe hidden upload metadata without a cursor path", () => {
    const upload = clickEvent({
      step_id: "step-upload",
      verb: "upload",
      pointer: null,
      cursor_applicability: "not_applicable",
      cursor_path: undefined,
      input_landmarks: { action: { frame_index: 2, pts_us: 2_000 } },
      upload_asset: {
        project_relative_path: "assets/sample.txt",
        basename: "sample.txt",
        byte_size: 12,
      },
    });
    expect(() =>
      validateRecordingActionsV3(actions([upload]), { requirePresented: true }),
    ).not.toThrow();
    expect(() =>
      validateRecordingActionsV3(
        actions([
          {
            ...upload,
            upload_asset: {
              project_relative_path: "/Users/me/private.txt",
              basename: "private.txt",
              byte_size: 12,
            },
          },
        ]),
      ),
    ).toThrow("upload_asset_path_invalid");
  });
});

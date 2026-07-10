import { describe, expect, it } from "vitest";

import scenarios from "./__fixtures__/action-sidecars/recording-scenarios.json";
import v1Raw from "./__fixtures__/action-sidecars/v1-short-gap.actions.json";
import v1Normalized from "./__fixtures__/action-sidecars/v1-short-gap.normalized.json";
import v2Raw from "./__fixtures__/action-sidecars/v2-explicit-timing.actions.json";
import v2Normalized from "./__fixtures__/action-sidecars/v2-explicit-timing.normalized.json";
import { parseActionSidecar, parseActionSidecarJson } from "./action-sidecar";

describe("cursor synchronization sidecar fixtures", () => {
  it("keeps sanitized v1 and v2 raw/golden pairs", () => {
    expect([v1Raw.version, v2Raw.version]).toEqual([1, 2]);
    expect([v1Normalized.source_version, v2Normalized.source_version]).toEqual([1, 2]);
    expect(v1Normalized.confidence).toBe("legacy-approximate");
    expect(v2Normalized.events.map((event) => event.confidence)).toEqual([
      "validated",
      "legacy-approximate",
    ]);

    const serialized = JSON.stringify([v1Raw, v1Normalized, v2Raw, v2Normalized]);
    expect(serialized).not.toMatch(/\/Users\/|locvotuan|@example\./i);
    expect(serialized).toContain("/fixtures/cursor-sync/");
  });

  it("normalizes v1 and v2 fixtures to their exact golden outputs", () => {
    expect(parseActionSidecar(v1Raw)).toEqual(v1Normalized);
    expect(parseActionSidecar(v2Raw)).toEqual(v2Normalized);
  });

  it("does not mutate raw sidecars", () => {
    const raw = structuredClone(v2Raw);
    const before = structuredClone(raw);

    parseActionSidecar(raw);

    expect(raw).toEqual(before);
  });

  it("fails closed for malformed, partial, and future sidecars", () => {
    expect(parseActionSidecarJson("{not-json")).toBeNull();
    expect(parseActionSidecar({ version: 2, events: [] })).toBeNull();
    expect(parseActionSidecar({ ...v2Raw, version: 99 })).toBeNull();
    expect(parseActionSidecar({ ...v2Raw, fps: Number.NaN })).toBeNull();
  });

  it("drops only an invalid event while preserving safe siblings", () => {
    const parsed = parseActionSidecar({
      ...v2Raw,
      events: [v2Raw.events[0], { ordinal: 2, verb: "click" }, v2Raw.events[1]],
    });

    expect(parsed?.events.map((event) => event.source_index)).toEqual([0, 2]);
    expect(parsed?.events.map((event) => event.step_id)).toEqual(["save", "next"]);
  });

  it("drops out-of-frame and non-monotonic events independently", () => {
    const parsed = parseActionSidecar({
      ...v2Raw,
      frame_count: 120,
      events: [
        v2Raw.events[0],
        { ...v2Raw.events[1], t_start_ms: 1400, t_action_ms: 1400, t_end_ms: 1500 },
        { ...v2Raw.events[1], t_start_ms: 1900, t_action_ms: 1950, t_end_ms: 2100 },
      ],
    });

    expect(parsed?.events.map((event) => event.source_index)).toEqual([0]);
  });

  it("accepts authoritative v3 media landmarks", () => {
    const parsed = parseActionSidecar({
      version: 3,
      recording_path: "/fixtures/cursor-sync/v3-authoritative.mp4",
      cursor_motion_preset: "natural",
      viewport: { width: 1280, height: 720 },
      capture_rect: { x: 0, y: 0, width: 1280, height: 720 },
      frame_count: 2,
      media_clock: {
        clock: "encoded_video_pts",
        unit: "us",
        fps_num: 60,
        fps_den: 1,
        origin_frame: 0,
        frame_count: 2,
        duration_us: 33334,
      },
      events: [
        {
          step_id: "v3-click",
          ordinal: 1,
          verb: "click",
          t_start_ms: 0,
          t_action_ms: 17,
          t_end_ms: 33,
          target: {
            kind: "element",
            label: "Confirm",
            center: { x: 640, y: 360 },
            bounds: { x: 600, y: 340, w: 80, h: 40 },
          },
          secondary_target: null,
          pointer: { button: "left", effect: "click" },
          cursor_timing: {
            motion_preset: "natural",
            start_ms: 0,
            arrival_ms: 16,
            travel_ms: 16,
            dwell_ms: 1,
          },
          input_timing: { kind: "click", down_ms: 17, up_ms: 17, action_ms: 17 },
          cursor_path: {
            interpolation: "linear-v1",
            samples: [
              { frame_index: 0, pts_us: 0, x: 320, y: 240 },
              { frame_index: 1, pts_us: 16667, x: 640, y: 360 },
            ],
            arrival: { frame_index: 1, pts_us: 16667 },
          },
          input_landmarks: {
            action: { frame_index: 1, pts_us: 16667 },
            down: { frame_index: 1, pts_us: 16667 },
            up: { frame_index: 1, pts_us: 16667 },
          },
          presentation: {
            status: "presented",
            first_post_input_frame: { frame_index: 1, pts_us: 16667 },
          },
        },
      ],
    });

    expect(parsed).toMatchObject({
      source_version: 3,
      confidence: "authoritative",
      fps_num: 60,
      fps_den: 1,
      events: [{ confidence: "authoritative" }],
    });
  });

  it("provides deterministic readiness, layout, pause, and decoder-stall sequences", () => {
    expect(scenarios.slow_target.observations.at(-1)?.at_ms).toBe(5500);
    expect(scenarios.layout_shift.observations.at(-1)?.center).toEqual(
      scenarios.layout_shift.expected_input_center,
    );
    expect(scenarios.pause.expected_pts_us).toEqual([0, 16667]);
    expect(scenarios.decoder_stall.expected_overlay_media_us).toEqual([
      0, 16667, 16667, 16667, 33333,
    ]);
  });
});

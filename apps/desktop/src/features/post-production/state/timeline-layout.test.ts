import { describe, expect, it } from "vitest";

import { parseTimelineLayoutJson, serializeTimelineLayout } from "./timeline-layout";
import type { TimelineSlice } from "./timeline-slice";

function tracks(): TimelineSlice["tracks"] {
  return {
    video: [],
    cursor: [],
    zoom: [],
    sound: [],
    annotations: [
      {
        id: "text-1",
        trackId: "annotations",
        startMs: 50,
        durationMs: 900,
        text: "Saved",
        pos: { x: 0.3, y: 0.4 },
        sizePt: 28,
        font: {
          kind: "system",
          family: "Acme Sans",
          fullName: "Acme Sans Bold",
          postscriptName: "AcmeSans-Bold",
          faceStyle: "Bold",
          weight: 700,
          style: "normal",
        },
        textShadow: null,
        boxStyle: null,
        sourceBinding: { kind: "story-text-overlay", stepId: "step-1", ordinal: 0 },
      },
    ],
  };
}

describe("timeline layout v4", () => {
  it("serializes current layouts as v4 and preserves annotation style metadata", () => {
    const json = serializeTimelineLayout({
      tracks: tracks(),
      durationMs: 1_000,
      background: { kind: "transparent" },
    });
    const parsed = parseTimelineLayoutJson(json);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.layout.version).toBe(4);
    expect(parsed.migrated).toBe(false);
    expect(parsed.layout.tracks.annotations[0]).toMatchObject({
      font: { kind: "system", postscriptName: "AcmeSans-Bold" },
      textShadow: null,
      boxStyle: null,
      sourceBinding: { stepId: "step-1", ordinal: 0 },
    });
  });

  it.each([1, 2, 3])("accepts and migrates a v%s layout", (version) => {
    const parsed = parseTimelineLayoutJson(
      JSON.stringify({
        version,
        timingModelVersion: 1,
        sourceRevision: null,
        tracks: tracks(),
        durationMs: 1_000,
        background: { kind: "transparent" },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.layout.version).toBe(4);
    expect(parsed.migrated).toBe(true);
    expect(parsed.layout.tracks.annotations[0]?.id).toBe("text-1");
  });

  it("migrates a legacy Vite image URL to a stable bundled asset id", () => {
    const parsed = parseTimelineLayoutJson(
      JSON.stringify({
        version: 3,
        timingModelVersion: 1,
        sourceRevision: null,
        tracks: tracks(),
        durationMs: 1_000,
        background: { kind: "image", path: "/assets/8-AbCd1234.jpg" },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.layout.background).toEqual({
      kind: "image",
      assetId: "cosmic:8",
      path: "/assets/8-AbCd1234.jpg",
    });
  });
});

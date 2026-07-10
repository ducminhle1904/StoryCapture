import { describe, expect, it } from "vitest";
import shortGapV1 from "@/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import { parseActionSidecar } from "@/ipc/action-sidecar";
import { buildCursorPresetReflow } from "../cursor-preset-reflow";
import { identitySourceTimelineMap } from "../source-timeline-map";

const tracks = {
  video: [
    {
      id: "v",
      trackId: "video" as const,
      startMs: 0,
      durationMs: 2_000,
      sourcePath: "/tmp/a.mp4",
      syncGroupId: "g",
      sourceTimeMap: identitySourceTimelineMap(2_000),
    },
  ],
  cursor: [
    {
      id: "c",
      trackId: "cursor" as const,
      startMs: 0,
      durationMs: 2_000,
      trajectoryDir: "/tmp/a.actions.json",
      trajectoryFps: 60,
      trajectoryFrameCount: 120,
      skin: "mac-default" as const,
      sizeScale: 1,
      syncGroupId: "g",
      sourceTimeMap: identitySourceTimelineMap(2_000),
    },
  ],
  zoom: [],
  sound: [],
  annotations: [],
};

describe("cursor preset reflow", () => {
  const actions = parseActionSidecar(shortGapV1);
  if (!actions) throw new Error("short-gap fixture must parse");

  it("compresses by default without changing the source map", () => {
    const result = buildCursorPresetReflow({
      tracks,
      cursorClipId: "c",
      actions,
      motionPreset: "cinematic",
      preserveFullMotion: false,
    });
    expect(result?.compressedSegments).toBeGreaterThan(0);
    expect(result?.insertedHoldUs).toBe(0);
  });

  it("inserts the exact requested deficit as one atomic sync-group action", () => {
    const result = buildCursorPresetReflow({
      tracks,
      cursorClipId: "c",
      actions,
      motionPreset: "cinematic",
      preserveFullMotion: true,
    });
    expect(result?.action.kind).toBe("edit-sync-group");
    expect(result?.insertedHoldUs).toBeGreaterThan(0);
    const video = result?.action.after.find((clip) => clip.trackId === "video");
    expect(video?.sourceTimeMap?.segments.some((segment) => segment.kind === "hold")).toBe(true);

    if (!result) throw new Error("expected preserve-full-motion reflow");
    const heldTracks = {
      ...tracks,
      video: result.action.after.filter((clip) => clip.trackId === "video"),
      cursor: result.action.after.filter((clip) => clip.trackId === "cursor"),
    };
    const reset = buildCursorPresetReflow({
      tracks: heldTracks,
      cursorClipId: "c",
      actions,
      motionPreset: "natural",
      preserveFullMotion: false,
    });
    expect(
      reset?.action.after
        .find((clip) => clip.trackId === "video")
        ?.sourceTimeMap?.segments.some(
          (segment) => segment.kind === "hold" && segment.reason === "cursor-motion",
        ),
    ).toBe(false);
    expect(reset?.action.after.find((clip) => clip.trackId === "video")?.durationMs).toBe(2_000);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import v1Raw from "../../src/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import v1Normalized from "../../src/ipc/__fixtures__/action-sidecars/v1-short-gap.normalized.json";
import { readRecordingActionsSidecar } from "./action-sidecar-reader";
import { actionsSidecarPath } from "./action-timeline";

const tempDirs: string[] = [];

async function recordingFixturePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-action-reader-"));
  tempDirs.push(dir);
  return path.join(dir, "recording.mp4");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readRecordingActionsSidecar", () => {
  it("returns normalized actions for a valid sidecar", async () => {
    const recordingPath = await recordingFixturePath();
    await fs.writeFile(actionsSidecarPath(recordingPath), JSON.stringify(v1Raw));

    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toEqual(v1Normalized);
  });

  it("keeps v1/v2 compatibility while accepting additive v3 policy metadata", async () => {
    const recordingPath = await recordingFixturePath();
    await fs.writeFile(
      actionsSidecarPath(recordingPath),
      JSON.stringify({
        version: 3,
        recording_path: recordingPath,
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
        events: [
          {
            policy_version: 1,
            include_cursor: true,
            target_match: { source: "step_primary", fallback_index: null },
            step_id: "step-click",
            ordinal: 1,
            verb: "click",
            t_start_ms: 0,
            t_action_ms: 2,
            t_end_ms: 3,
            target: null,
            secondary_target: null,
            pointer: { button: "left", effect: "click" },
            input_timing: { kind: "click", down_ms: 1, up_ms: 2, action_ms: 2 },
            input_delivery: "browser_injected",
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
          },
        ],
      }),
    );

    const parsed = await readRecordingActionsSidecar(recordingPath);
    expect(parsed?.source_version).toBe(3);
    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.events[0]?.confidence).toBe("authoritative");
  });

  it("returns null for missing, malformed, partial, and future sidecars", async () => {
    const recordingPath = await recordingFixturePath();
    const actionsPath = actionsSidecarPath(recordingPath);

    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, "{not-json");
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, JSON.stringify({ version: 2, events: [] }));
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, JSON.stringify({ ...v1Raw, version: 99 }));
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
  });

  it("does not hide non-ENOENT filesystem failures", async () => {
    const recordingPath = await recordingFixturePath();
    await fs.mkdir(actionsSidecarPath(recordingPath));

    await expect(readRecordingActionsSidecar(recordingPath)).rejects.toBeDefined();
  });
});

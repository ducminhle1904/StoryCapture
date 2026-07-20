import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeRecording } from "./media-probe";
import { generateRecordingVerifierFixture } from "./recording-verifier-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deterministic recording fixture encoder", () => {
  it("generates a full-decodable 1080p60 FFV1 artifact", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v2-fixture-"));
    tempDirs.push(directory);
    const fixturePath = path.join(directory, "fixture.mkv");

    await generateRecordingVerifierFixture(fixturePath, { frameCount: 2 });
    const probe = await probeRecording(fixturePath);

    expect(probe).toMatchObject({
      status: "valid",
      width: 1920,
      height: 1080,
      codec: "ffv1",
      pixel_format: "bgra",
      counted_frames: 2,
      real_frame_rate: { numerator: 60, denominator: 1 },
      average_frame_rate: { numerator: 60, denominator: 1 },
      full_decode_succeeded: true,
    });
    if (probe.status !== "valid") throw new Error("expected a valid fixture probe");
    expect(probe.frames).toHaveLength(2);
    expect(probe.frames.map((frame) => frame.pts_time_seconds)).toEqual([0, expect.any(Number)]);
    expect(probe.frames.every((frame) => frame.duration_time_seconds !== null)).toBe(true);
  }, 60_000);
});

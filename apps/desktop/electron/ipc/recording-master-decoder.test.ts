import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegExecutablePath } from "./export-binaries";
import { SequentialMasterDecoder } from "./recording-master-decoder";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("SequentialMasterDecoder", () => {
  it("delivers exact BGRA frames by monotonically increasing frame index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-decoder-test-"));
    roots.push(root);
    const masterPath = path.join(root, "master.mkv");
    const frames = [1, 2, 3].map((value) => new Uint8Array(16 * 16 * 4).fill(value));
    const fixture = spawnSync(
      ffmpegExecutablePath(),
      [
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "bgra",
        "-video_size",
        "16x16",
        "-framerate",
        "60/1",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-g",
        "1",
        "-pix_fmt",
        "bgra",
        masterPath,
      ],
      { input: Buffer.concat(frames.map((frame) => Buffer.from(frame))) },
    );
    expect(fixture.status, String(fixture.stderr)).toBe(0);

    const decoder = new SequentialMasterDecoder(masterPath, 16, 16);
    expect(await decoder.readFrame(0)).toEqual(frames[0]);
    expect(await decoder.readFrame(2)).toEqual(frames[2]);
    await expect(decoder.readFrame(1)).rejects.toThrow(/sequential/);
    decoder.close();
  }, 30_000);
});

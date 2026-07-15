import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportBinaryPathForTest, exportFfmpegPath, exportFfprobePath } from "./export-binaries";

describe("packaged export binary resolution", () => {
  it("moves binaries out of app.asar while keeping normal paths unchanged", () => {
    const packaged = path.join(
      "/Applications",
      "StoryCapture.app",
      "Contents",
      "Resources",
      "app.asar",
      "node_modules",
      "tool",
      "binary",
    );
    expect(exportBinaryPathForTest(packaged)).toContain(`${path.sep}app.asar.unpacked${path.sep}`);
    expect(exportBinaryPathForTest("/usr/local/bin/ffmpeg")).toBe("/usr/local/bin/ffmpeg");
  });

  it("resolves executable FFmpeg and ffprobe dependencies", () => {
    expect(exportFfmpegPath()).toMatch(/ffmpeg/i);
    expect(exportFfprobePath()).toMatch(/ffprobe/i);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ffmpegExecutablePath: vi.fn(() => process.execPath),
}));

vi.mock("./export-binaries", () => ({
  ffmpegExecutablePath: mocks.ffmpegExecutablePath,
}));

import { probeRecording } from "./media-probe";

const tempDirs: string[] = [];

describe("recording media probe binary resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("uses the shared resolver before probing a recording", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-probe-binary-"));
    tempDirs.push(dir);
    const file = path.join(dir, "recording.mp4");
    await fs.writeFile(file, "fixture");

    const result = await probeRecording(file);

    expect(mocks.ffmpegExecutablePath).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "invalid",
      reason: "unsupported_or_corrupt",
    });
  });
});

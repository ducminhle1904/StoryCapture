import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ffmpegExecutablePath: vi.fn(() => process.execPath),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/storycapture-test" },
  BrowserWindow: vi.fn(),
  desktopCapturer: { getSources: vi.fn() },
  dialog: {},
  screen: {},
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("../export-binaries", () => ({
  ffmpegExecutablePath: mocks.ffmpegExecutablePath,
}));

import { startRecordingFfmpegPipe } from "./capture-preview";
import { runFfmpeg } from "./recording";

describe("legacy recording binary resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared resolver for the author-preview streaming encoder", async () => {
    const { child, done } = startRecordingFfmpegPipe(["--version"]);

    expect(mocks.ffmpegExecutablePath).toHaveBeenCalledOnce();
    expect(child.spawnfile).toBe(process.execPath);
    await expect(done).resolves.toBeUndefined();
  });

  it("uses the shared resolver for legacy finalization", async () => {
    const done = runFfmpeg(["--version"]);

    expect(mocks.ffmpegExecutablePath).toHaveBeenCalledOnce();
    await expect(done).resolves.toBeUndefined();
  });
});

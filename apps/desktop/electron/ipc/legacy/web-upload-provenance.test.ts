import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
  loadSecret: vi.fn(),
}));

vi.mock("../recording-v3-export-provenance", () => ({
  assertRecordingV3UploadAllowed: mocks.assertAllowed,
}));

vi.mock("../generic-secret-store", () => ({
  deleteGenericSecret: vi.fn(),
  loadOptionalGenericSecret: mocks.loadSecret,
  storeGenericSecret: vi.fn(),
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
    },
  },
}));

import { uploadVideo } from "./web";

describe("upload Recording V3 provenance admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAllowed.mockRejectedValue(
      new Error("Uncertified Development recordings and exports cannot be uploaded or shared."),
    );
  });

  it("rejects explicit development provenance before reading credentials or starting network work", async () => {
    await expect(
      uploadVideo(
        {
          videoPath: "/missing/demo-uncertified-dev.mp4",
          recordingMode: "uncertified_development",
        },
        {} as never,
      ),
    ).rejects.toThrow(/cannot be uploaded or shared/i);

    expect(mocks.assertAllowed).toHaveBeenCalledWith(
      "/missing/demo-uncertified-dev.mp4",
      "uncertified_development",
    );
    expect(mocks.loadSecret).not.toHaveBeenCalled();
  });
});

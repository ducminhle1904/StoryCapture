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
      new Error(
        "Strict Local recordings and exports are runtime-verified but not release-certified, so they cannot be uploaded or shared.",
      ),
    );
  });

  it("rejects explicit Strict Local provenance before reading credentials or starting network work", async () => {
    await expect(
      uploadVideo(
        {
          videoPath: "/missing/demo-strict-local.mp4",
          recordingMode: "strict_local",
        },
        {} as never,
      ),
    ).rejects.toThrow(/cannot be uploaded or shared/i);

    expect(mocks.assertAllowed).toHaveBeenCalledWith(
      "/missing/demo-strict-local.mp4",
      "strict_local",
    );
    expect(mocks.loadSecret).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: {
    getVersion: vi.fn(() => "0.0.0-test"),
    isPackaged: false,
  },
}));

const updaterMock = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock("electron", () => electronMock);

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: updaterMock,
  },
}));

import { updatesHandlers } from "./updates";

describe("updates IPC handlers", () => {
  beforeEach(() => {
    delete process.env.STORYCAPTURE_DEBUG_UPDATER;
    electronMock.app.isPackaged = false;
    updaterMock.autoDownload = true;
    updaterMock.autoInstallOnAppQuit = true;
    updaterMock.checkForUpdates.mockReset();
    updaterMock.downloadUpdate.mockResolvedValue([]);
    updaterMock.quitAndInstall.mockReset();
  });

  afterEach(async () => {
    delete process.env.STORYCAPTURE_DEBUG_UPDATER;
    electronMock.app.isPackaged = false;
    await updatesHandlers.check_update();
  });

  it("keeps development update checks disabled by default", async () => {
    await expect(updatesHandlers.check_update()).resolves.toBeNull();
    expect(updaterMock.checkForUpdates).not.toHaveBeenCalled();

    await expect(updatesHandlers.install_update()).rejects.toThrow(
      "updater install is unavailable in development builds",
    );
  });

  it("checks and installs updates when debug updater mode is enabled", async () => {
    process.env.STORYCAPTURE_DEBUG_UPDATER = "1";
    updaterMock.checkForUpdates.mockResolvedValue({
      updateInfo: {
        version: "0.0.1-test",
        releaseDate: "2026-06-20T00:00:00.000Z",
        releaseNotes: [{ note: "Test release" }],
      },
    });

    await expect(updatesHandlers.check_update()).resolves.toEqual({
      version: "0.0.1-test",
      date: "2026-06-20T00:00:00.000Z",
      body: "Test release",
      current_version: "0.0.0-test",
    });
    expect(updaterMock.autoDownload).toBe(false);
    expect(updaterMock.autoInstallOnAppQuit).toBe(false);

    await expect(updatesHandlers.install_update()).resolves.toBeNull();
    expect(updaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});

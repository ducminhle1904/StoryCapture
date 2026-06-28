import { describe, expect, it, vi } from "vitest";

import {
  devIdentityStatus,
  mapScreenCaptureStatus,
  screenCapturePermissionReport,
} from "./screen-capture";

describe("screen capture permission helpers", () => {
  it("maps macOS screen capture statuses", () => {
    expect(mapScreenCaptureStatus("granted")).toBe("granted");
    expect(mapScreenCaptureStatus("denied")).toBe("denied");
    expect(mapScreenCaptureStatus("restricted")).toBe("denied");
    expect(mapScreenCaptureStatus("not-determined")).toBe("undetermined");
    expect(mapScreenCaptureStatus("unknown")).toBe("undetermined");
    expect(mapScreenCaptureStatus("future-status")).toBe("undetermined");
  });

  it("validates dev and production bundle identities", () => {
    expect(
      devIdentityStatus({
        platform: "darwin",
        isPackaged: false,
        bundleId: "com.storycapture.desktop.dev",
      }),
    ).toBe(true);
    expect(
      devIdentityStatus({
        platform: "darwin",
        isPackaged: false,
        bundleId: "com.github.Electron",
      }),
    ).toBe(false);
    expect(
      devIdentityStatus({
        platform: "darwin",
        isPackaged: true,
        bundleId: "com.storycapture.desktop",
      }),
    ).toBe(true);
    expect(
      devIdentityStatus({
        platform: "win32",
        isPackaged: false,
        bundleId: null,
      }),
    ).toBeNull();
  });

  it("does not enumerate sources when checking permission", async () => {
    const enumerateScreenSources = vi.fn(async () => 1);

    const report = await screenCapturePermissionReport(
      {
        platform: "darwin",
        isPackaged: false,
        executablePath: "/not/an/app/Electron",
        fallbackAppName: "StoryCapture Dev",
        debugBypassAllowed: false,
        getMediaAccessStatus: () => "granted",
        enumerateScreenSources,
      },
      { probe: false },
    );

    expect(report.state).toBe("granted");
    expect(report.canEnumerateSources).toBe(false);
    expect(enumerateScreenSources).not.toHaveBeenCalled();
  });

  it("returns undetermined with a reason when reading status fails", async () => {
    const report = await screenCapturePermissionReport(
      {
        platform: "darwin",
        isPackaged: false,
        executablePath: "/not/an/app/Electron",
        fallbackAppName: "StoryCapture Dev",
        debugBypassAllowed: false,
        getMediaAccessStatus: () => {
          throw new Error("TCC unavailable");
        },
        enumerateScreenSources: async () => 0,
      },
      { probe: false },
    );

    expect(report.state).toBe("undetermined");
    expect(report.reason).toContain("TCC unavailable");
  });

  it("enumerates sources when requesting permission", async () => {
    const enumerateScreenSources = vi.fn(async () => 2);

    const report = await screenCapturePermissionReport(
      {
        platform: "darwin",
        isPackaged: false,
        executablePath: "/not/an/app/Electron",
        fallbackAppName: "StoryCapture Dev",
        debugBypassAllowed: false,
        getMediaAccessStatus: () => "not-determined",
        enumerateScreenSources,
      },
      { probe: true },
    );

    expect(report.state).toBe("granted");
    expect(report.canEnumerateSources).toBe(true);
    expect(report.sourceCount).toBe(2);
    expect(enumerateScreenSources).toHaveBeenCalledOnce();
  });

  it("returns a non-granted report when the probe times out", async () => {
    const report = await screenCapturePermissionReport(
      {
        platform: "darwin",
        isPackaged: false,
        executablePath: "/not/an/app/Electron",
        fallbackAppName: "StoryCapture Dev",
        debugBypassAllowed: false,
        getMediaAccessStatus: () => "not-determined",
        enumerateScreenSources: () => new Promise(() => {}),
      },
      { probe: true, timeoutMs: 1 },
    );

    expect(report.state).toBe("undetermined");
    expect(report.canEnumerateSources).toBe(false);
    expect(report.reason).toContain("timed out");
  });
});

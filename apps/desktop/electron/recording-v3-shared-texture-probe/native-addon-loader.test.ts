import path from "node:path";
import { describe, expect, it } from "vitest";

import { nativeSharedTextureProbeAddonPath } from "./native-addon-loader";

describe("native shared-texture probe loader", () => {
  it("uses an explicit build path in development", () => {
    expect(
      nativeSharedTextureProbeAddonPath({
        isPackaged: false,
        resourcesPath: "/resources",
        desktopRoot: "/repo/apps/desktop",
      }),
    ).toBe(
      path.join(
        "/repo/apps/desktop",
        "native/macos-shared-texture-probe/.build/storycapture_shared_texture_probe.node",
      ),
    );
  });

  it("uses only the packaged extraResource path in packaged mode", () => {
    expect(
      nativeSharedTextureProbeAddonPath({
        isPackaged: true,
        resourcesPath: "/Applications/Probe.app/Contents/Resources",
        desktopRoot: "/repo/apps/desktop",
      }),
    ).toBe(
      path.join(
        "/Applications/Probe.app/Contents/Resources",
        "native/macos/storycapture_shared_texture_probe.node",
      ),
    );
  });
});

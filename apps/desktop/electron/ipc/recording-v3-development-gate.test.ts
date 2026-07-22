import { describe, expect, it } from "vitest";

import {
  isRecordingV3DevelopmentEnabled,
  RECORDING_V3_DEVELOPMENT_ENABLE_ENV,
} from "./recording-v3-development-gate";

const generatedDevExecutable =
  "/repo/apps/desktop/.electron-dev/StoryCapture Dev.app/Contents/MacOS/StoryCapture Dev";
const productionExecutable = "/Applications/StoryCapture.app/Contents/MacOS/StoryCapture";

describe("isRecordingV3DevelopmentEnabled", () => {
  it("requires the explicit feature flag in an unpackaged runtime", () => {
    expect(isRecordingV3DevelopmentEnabled({ isPackaged: false }, {}, "/usr/bin/electron")).toBe(
      false,
    );
    expect(
      isRecordingV3DevelopmentEnabled(
        { isPackaged: false },
        { [RECORDING_V3_DEVELOPMENT_ENABLE_ENV]: "1" },
        "/usr/bin/electron",
      ),
    ).toBe(true);
  });

  it("enables the generated development app only with both required flags", () => {
    expect(
      isRecordingV3DevelopmentEnabled(
        { isPackaged: true },
        {
          STORYCAPTURE_DEV_APP: "1",
          [RECORDING_V3_DEVELOPMENT_ENABLE_ENV]: "1",
        },
        generatedDevExecutable,
      ),
    ).toBe(true);
  });

  it("rejects a generated-dev identity paired with a non-matching executable", () => {
    expect(
      isRecordingV3DevelopmentEnabled(
        { isPackaged: true },
        {
          STORYCAPTURE_DEV_APP: "1",
          [RECORDING_V3_DEVELOPMENT_ENABLE_ENV]: "1",
        },
        productionExecutable,
      ),
    ).toBe(false);
  });

  it.each([
    {},
    { STORYCAPTURE_DEV_APP: "1" },
    { [RECORDING_V3_DEVELOPMENT_ENABLE_ENV]: "1" },
    {
      STORYCAPTURE_DEV_APP: "1",
      [RECORDING_V3_DEVELOPMENT_ENABLE_ENV]: "1",
    },
  ])("rejects production packaged executables with forced flags", (env) => {
    expect(
      isRecordingV3DevelopmentEnabled({ isPackaged: true }, env, productionExecutable),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { recordingEncoderFailure, recordingErrorCode } from "./recording-errors";

describe("recording encoder errors", () => {
  it("preserves safe process error codes without exposing executable paths", () => {
    const cause = Object.assign(
      new Error(
        "spawn /Applications/StoryCapture.app/Contents/Resources/app.asar/bin/ffmpeg ENOTDIR",
      ),
      { code: "ENOTDIR" },
    );

    const error = recordingEncoderFailure(cause, "start");

    expect(error.message).toBe("Recording encoder could not start (ENOTDIR)");
    expect(recordingErrorCode(error)).toBe("ENOTDIR");
    expect(error.message).not.toContain("/Applications");
  });

  it("uses a safe fallback when an error has no diagnostic code", () => {
    const error = recordingEncoderFailure(new Error("sensitive details"), "finalize");

    expect(error.message).toBe("Recording encoder could not finalize the video");
    expect(recordingErrorCode(error)).toBeNull();
  });
});

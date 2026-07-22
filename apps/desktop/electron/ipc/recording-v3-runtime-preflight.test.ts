import {
  type RecordingPreflightV3Request,
  recordingV3DimensionsForViewport,
} from "@storycapture/shared-types/recording-v3";
import { describe, expect, it } from "vitest";

import { recordingV3SourceMetadataFailure } from "./recording-v3-runtime-preflight";

describe("Recording V3 runtime preflight", () => {
  it("validates source texture format and coded size against the request", () => {
    const request: RecordingPreflightV3Request = {
      version: 3,
      enforcement_mode: "strict",
      certification_mode: "local",
      target_class: "browser",
      requested_fps: { numerator: 60, denominator: 1 },
      dimensions: recordingV3DimensionsForViewport("local", {
        width: 1280,
        height: 800,
      }),
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    };
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1280, height: 800 },
        pixelFormat: "bgra",
      }),
    ).toBeNull();
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1920, height: 1080 },
        pixelFormat: "bgra",
      }),
    ).toBe("source_metadata_invalid");
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1280, height: 800 },
        pixelFormat: "rgba",
      }),
    ).toBe("source_metadata_invalid");
  });

});

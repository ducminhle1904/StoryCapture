import type { RecordingDimensionsV2 } from "@storycapture/shared-types/recording-v2";

import {
  type MacNativeMasterResult,
  MacOSNativeMasterBackend,
} from "./macos-screen-capture-backend";
import type { RecordingNativeBrowserSurface } from "./recording-native-browser-surface";
import type { RecordingNativeMasterEvidence } from "./recording-native-master-bundle";
import { WindowsNativeMp4CaptureSession } from "./windows-capture-backend";

export interface RecordingNativePlatformSession {
  readonly backend: { id: string; version: string };
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<RecordingNativeMasterEvidence>;
  close(): Promise<void>;
}

export interface RecordingNativePlatformSessionOptions {
  platform: NodeJS.Platform;
  helperPath: string;
  sessionId: string;
  artifactPath: string;
  dimensions: RecordingDimensionsV2;
  surface: RecordingNativeBrowserSurface;
}

function macEvidence(result: MacNativeMasterResult): RecordingNativeMasterEvidence {
  return { ...result, failure_codes: [] };
}

export function createRecordingNativePlatformSession(
  options: RecordingNativePlatformSessionOptions,
): RecordingNativePlatformSession {
  const width = options.dimensions.requested_output_width;
  const height = options.dimensions.requested_output_height;
  if (options.platform === "darwin") {
    const native = new MacOSNativeMasterBackend({
      helperPath: options.helperPath,
      target: options.surface.macTarget(),
    });
    return {
      backend: { id: "macos-screencapturekit-native-master", version: "3.0.0" },
      async start() {
        await native.probeCapabilities();
        await native.start({
          sessionId: options.sessionId,
          artifactPath: options.artifactPath,
          outputWidth: width,
          outputHeight: height,
          expectedLogicalWidth: options.dimensions.logical_width,
          expectedLogicalHeight: options.dimensions.logical_height,
          fps: { numerator: 60, denominator: 1 },
          showsCursor: true,
          dynamicSizePolicy: "fail_on_change",
        });
      },
      pause: () => native.pause(),
      resume: () => native.resume(),
      async stop() {
        return macEvidence(await native.stop());
      },
      async close() {
        native.close();
      },
    };
  }
  if (options.platform === "win32") {
    const native = new WindowsNativeMp4CaptureSession({ helperPath: options.helperPath });
    let encoderId = "unknown-hardware-h264";
    return {
      backend: { id: "windows-graphics-capture-native-master", version: "3.0.0" },
      async start() {
        const capabilities = await native.capabilities();
        encoderId = capabilities.encoder_id;
        await native.start({
          session_id: options.sessionId,
          output_path: options.artifactPath,
          target: options.surface.windowsTarget(),
          cursor_policy: "include",
          dynamic_size_policy: "fail",
          requested_width: width,
          requested_height: height,
          requested_fps: { numerator: 60, denominator: 1 },
        });
      },
      pause: () => native.pause(),
      resume: () => native.resume(),
      async stop() {
        const result = await native.stop();
        return {
          artifact_path: result.artifact_path,
          artifact_bytes: 0,
          source_updates: result.source_frames,
          output_frames: result.output_frames,
          held_frames: result.held_frames,
          encoder_dropped_frames: result.encoder_dropped_frames,
          backpressure_events: result.backpressure_events,
          unresolved_backpressure_events: result.unresolved_backpressure_events,
          width: result.width,
          height: result.height,
          started_monotonic_us: result.started_monotonic_us,
          ended_monotonic_us: result.ended_monotonic_us,
          finalized_duration_us: result.finalized_duration_us,
          pts_gaps: result.pts_gaps,
          pts_duplicates: result.pts_duplicates,
          pts_non_monotonic: result.pts_non_monotonic,
          encoder: { id: result.encoder_id || encoderId, hardware_accelerated: true },
          codec: result.codec,
          pixel_format: result.pixel_format,
          finalized: result.finalized,
          artifact: {
            finalized: result.finalized,
            full_decode_succeeded: false,
            decoded_frames: 0,
          },
          failure_codes: result.failure_codes,
        };
      },
      close: () => native.shutdown(),
    };
  }
  throw new Error(`strict native recording is unsupported on ${options.platform}`);
}

import type { SupportedExportCompositionGraph } from "@storycapture/shared-types";

import {
  type CanonicalMediaHandle,
  CanonicalMediaSourcePool,
} from "../export-compositor/media-source-pool";
import type { ExportSourceNode } from "../export-compositor/scene-evaluator";

const RATE_CORRECTION_DEAD_ZONE_US = 20_000;
const HARD_SEEK_THRESHOLD_US = 240_000;
const MIN_PLAYBACK_RATE = 0.97;
const MAX_PLAYBACK_RATE = 1.03;
const RATE_CORRECTION_GAIN = 0.25;

export type PreviewTransportDiscontinuity =
  | "initial"
  | "scrub"
  | "source-switch"
  | "loop"
  | "pause"
  | "ended"
  | "error"
  | "teardown"
  | "large-drift";

export interface SequentialPreviewDiagnostics {
  presented_frames: number;
  hard_seeks: number;
  drift_corrections: number;
  coalesced_requests: number;
  dropped_or_late_frames: number;
}

interface MutableDiagnostics extends SequentialPreviewDiagnostics {
  last_presented_at_ms: number | null;
  last_presented_frames: number | null;
}

function durationUs(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration > 0
    ? Math.round(video.duration * 1_000_000)
    : null;
}

function clampSourcePtsUs(
  video: HTMLVideoElement,
  sourcePtsUs: number,
  frameDurationUs: number,
): number {
  const duration = durationUs(video);
  const terminalUs =
    duration == null ? Number.POSITIVE_INFINITY : Math.max(0, duration - frameDurationUs);
  return Math.max(0, Math.min(sourcePtsUs, terminalUs));
}

function waitForVideoReady(video: HTMLVideoElement, node: ExportSourceNode): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`failed to load sequential preview source: ${node.path}`));
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function snapshotDiagnostics(state: MutableDiagnostics): SequentialPreviewDiagnostics {
  return {
    presented_frames: state.presented_frames,
    hard_seeks: state.hard_seeks,
    drift_corrections: state.drift_corrections,
    coalesced_requests: state.coalesced_requests,
    dropped_or_late_frames: state.dropped_or_late_frames,
  };
}

/**
 * Preview-only media pool. Canonical drawing reads from the same video element
 * that owns playback and presented-frame callbacks, so preview never creates a
 * second decoder for the active source. Export keeps the exact random-access
 * pool unchanged.
 */
export class SequentialPreviewMediaController extends CanonicalMediaSourcePool {
  private readonly diagnostics: MutableDiagnostics = {
    presented_frames: 0,
    hard_seeks: 0,
    drift_corrections: 0,
    coalesced_requests: 0,
    dropped_or_late_frames: 0,
    last_presented_at_ms: null,
    last_presented_frames: null,
  };

  constructor(private readonly getVideo: () => HTMLVideoElement | null) {
    super(async (node) => this.createSharedHandle(node));
  }

  override configure(graph: SupportedExportCompositionGraph): Promise<void> {
    return super.configure(graph, "preview");
  }

  hardSeek(sourcePtsUs: number, reason: PreviewTransportDiscontinuity): void {
    const video = this.getVideo();
    if (!video) return;
    const clampedUs = clampSourcePtsUs(video, sourcePtsUs, 1);
    const targetSeconds = clampedUs / 1_000_000;
    video.playbackRate = 1;
    if (Math.abs(video.currentTime - targetSeconds) >= 0.0005) {
      video.currentTime = targetSeconds;
      this.diagnostics.hard_seeks += 1;
    }
    if (reason === "error" || reason === "teardown") video.pause();
  }

  reset(reason: PreviewTransportDiscontinuity): void {
    const video = this.getVideo();
    if (video) {
      video.playbackRate = 1;
      if (reason !== "source-switch" && reason !== "initial") video.pause();
    }
    this.diagnostics.last_presented_at_ms = null;
    this.diagnostics.last_presented_frames = null;
  }

  recordPresentedFrame(
    presentedAtMs: number,
    expectedFrameIntervalMs: number,
    presentedFrames?: number,
  ): void {
    this.diagnostics.presented_frames += 1;
    const previousPresentedFrames = this.diagnostics.last_presented_frames;
    if (
      presentedFrames !== undefined &&
      previousPresentedFrames !== null &&
      presentedFrames > previousPresentedFrames + 1
    ) {
      this.diagnostics.dropped_or_late_frames += presentedFrames - previousPresentedFrames - 1;
    }
    const previous = this.diagnostics.last_presented_at_ms;
    if (
      previous !== null &&
      presentedAtMs - previous > Math.max(1, expectedFrameIntervalMs) * 1.75
    ) {
      this.diagnostics.dropped_or_late_frames += 1;
    }
    this.diagnostics.last_presented_at_ms = presentedAtMs;
    this.diagnostics.last_presented_frames = presentedFrames ?? null;
  }

  recordCoalescedRequest(): void {
    this.diagnostics.coalesced_requests += 1;
  }

  diagnosticsSnapshot(): SequentialPreviewDiagnostics {
    return snapshotDiagnostics(this.diagnostics);
  }

  override dispose(): void {
    this.reset("teardown");
    super.dispose();
  }

  private async createSharedHandle(node: ExportSourceNode): Promise<CanonicalMediaHandle> {
    const video = this.getVideo();
    if (!video) throw new Error(`sequential preview video is unavailable: ${node.path}`);
    await waitForVideoReady(video, node);
    return {
      source: video,
      get duration_us() {
        return durationUs(video);
      },
      seek: async (sourcePtsUs, options) => {
        const clampedUs = clampSourcePtsUs(video, sourcePtsUs, options.frame_duration_us);
        const currentUs = Math.max(0, Math.round(video.currentTime * 1_000_000));
        const driftUs = clampedUs - currentUs;
        const absoluteDriftUs = Math.abs(driftUs);

        if (video.paused || absoluteDriftUs >= HARD_SEEK_THRESHOLD_US) {
          this.hardSeek(
            clampedUs,
            absoluteDriftUs >= HARD_SEEK_THRESHOLD_US ? "large-drift" : "scrub",
          );
          return;
        }
        if (video.seeking) {
          this.recordCoalescedRequest();
          return;
        }
        if (absoluteDriftUs <= RATE_CORRECTION_DEAD_ZONE_US) {
          video.playbackRate = 1;
          return;
        }

        const correction = (driftUs / 1_000_000) * RATE_CORRECTION_GAIN;
        video.playbackRate = Math.max(
          MIN_PLAYBACK_RATE,
          Math.min(MAX_PLAYBACK_RATE, 1 + correction),
        );
        this.diagnostics.drift_corrections += 1;
      },
      dispose() {
        video.playbackRate = 1;
      },
    };
  }
}

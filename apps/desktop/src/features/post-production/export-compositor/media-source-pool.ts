import type { SupportedExportCompositionGraph } from "@storycapture/shared-types";
import {
  closeRecordingMasterDecoder,
  decodeRecordingMasterFrame,
  openRecordingMasterDecoder,
} from "@/ipc/recording-master";

import type { EvaluatedScene, ExportSourceNode } from "./scene-evaluator";
import { nodesOf } from "./scene-evaluator";

export interface CanonicalMediaHandle {
  readonly source: CanvasImageSource;
  readonly duration_us: number | null;
  seek(
    sourcePtsUs: number,
    options: { last_frame: boolean; frame_duration_us: number },
  ): Promise<void>;
  dispose(): void;
}

export type CanonicalSourceMode = "preview" | "export";
export type CanonicalMediaLoader = (
  node: ExportSourceNode,
  mode?: CanonicalSourceMode,
) => Promise<CanonicalMediaHandle>;

interface PoolEntry {
  node: ExportSourceNode;
  handle: CanonicalMediaHandle;
  last_source_pts_us: number | null;
}

export function canonicalAssetUrl(path: string): string {
  if (/^(?:https?:|data:|blob:|asset:|storycapture-asset:)/i.test(path)) return path;
  if (path.startsWith("file:")) {
    return `storycapture-asset://local/${encodeURIComponent(
      decodeURIComponent(new URL(path).pathname),
    )}`;
  }
  return `storycapture-asset://local/${encodeURIComponent(path)}`;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  successEvent: "loadeddata" | "seeked",
  errorMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(successEvent, onSuccess);
      video.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(errorMessage));
    };
    video.addEventListener(successEvent, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

export const loadDomMediaSource: CanonicalMediaLoader = async (node) => {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const loaded = waitForVideoEvent(
    video,
    "loadeddata",
    `failed to load canonical source video: ${node.path}`,
  );
  video.src = canonicalAssetUrl(node.path);
  video.load();
  await loaded;

  return {
    source: video,
    get duration_us() {
      return Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1_000_000)
        : null;
    },
    async seek(sourcePtsUs, options) {
      const durationUs =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.round(video.duration * 1_000_000)
          : null;
      const terminalUs =
        durationUs == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, durationUs - Math.max(1, options.frame_duration_us));
      // Seeking exactly to media.duration has no decodable frame and behaves
      // differently across Chromium backends. Always clamp to the final full
      // frame, even when the graph still considers an overstated source active.
      const clampedUs = Math.max(0, Math.min(sourcePtsUs, terminalUs));
      const timeSeconds = clampedUs / 1_000_000;
      if (Math.abs(video.currentTime - timeSeconds) < 0.0005 && video.readyState >= 2) return;
      const seeked = waitForVideoEvent(
        video,
        "seeked",
        `canonical source seek failed: ${node.path}`,
      );
      video.currentTime = timeSeconds;
      await seeked;
    },
    dispose() {
      video.pause();
      video.removeAttribute("src");
      video.load();
    },
  };
};

function bgraToRgba(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(bytes.byteLength));
  for (let index = 0; index < bytes.byteLength; index += 4) {
    rgba[index] = bytes[index + 2] ?? 0;
    rgba[index + 1] = bytes[index + 1] ?? 0;
    rgba[index + 2] = bytes[index] ?? 0;
    rgba[index + 3] = bytes[index + 3] ?? 255;
  }
  return rgba;
}

export const loadCanonicalMediaSource: CanonicalMediaLoader = async (node, mode = "preview") => {
  const source = node.recording_source;
  if (mode !== "export" || !source) return loadDomMediaSource(node);

  const canvas = document.createElement("canvas");
  canvas.width = source.master_width;
  canvas.height = source.master_height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("canonical master decoder canvas is unavailable");
  const handle = await openRecordingMasterDecoder({
    path: source.master_path,
    width: source.master_width,
    height: source.master_height,
  });
  let lastFrameIndex = -1;
  return {
    source: canvas,
    duration_us: Math.round(
      (source.source_frame_count * source.exact_source_fps.denominator * 1_000_000) /
        source.exact_source_fps.numerator,
    ),
    async seek(sourcePtsUs) {
      const frameIndex = Math.min(
        source.source_frame_count - 1,
        Math.max(
          0,
          Math.floor(
            (sourcePtsUs * source.exact_source_fps.numerator) /
              (source.exact_source_fps.denominator * 1_000_000),
          ),
        ),
      );
      if (frameIndex === lastFrameIndex) return;
      const bgra = await decodeRecordingMasterFrame(handle, frameIndex);
      context.putImageData(
        new ImageData(bgraToRgba(bgra), source.master_width, source.master_height),
        0,
        0,
      );
      lastFrameIndex = frameIndex;
    },
    dispose() {
      void closeRecordingMasterDecoder(handle);
    },
  };
};

/**
 * Owns every source independently. It intentionally seeks in stable graph
 * order: parallel seeks make browser completion order observable and caused
 * nondeterministic frames in the legacy single-video implementation.
 */
export class CanonicalMediaSourcePool {
  private entries = new Map<string, PoolEntry>();
  private generation = 0;
  private outputFps = 60;

  constructor(private readonly loader: CanonicalMediaLoader = loadCanonicalMediaSource) {}

  async configure(
    graph: SupportedExportCompositionGraph,
    mode: CanonicalSourceMode = "preview",
  ): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    this.disposeEntries();
    this.outputFps = Math.max(1, graph.output_fps);
    const loaded: PoolEntry[] = [];
    try {
      for (const node of nodesOf(graph, "source").sort(
        (a, b) => a.timeline_start_ms - b.timeline_start_ms || a.clip_id.localeCompare(b.clip_id),
      )) {
        if (!node.path) throw new Error(`canonical source ${node.id} has no path`);
        const handle = await this.loader(node, mode);
        if (generation !== this.generation) {
          handle.dispose();
          throw new Error("canonical media source configuration was superseded");
        }
        loaded.push({ node, handle, last_source_pts_us: null });
      }
    } catch (error) {
      for (const entry of loaded) entry.handle.dispose();
      throw error;
    }
    this.entries = new Map(loaded.map((entry) => [entry.node.id, entry]));
  }

  async prepare(scene: EvaluatedScene): Promise<void> {
    const frameDurationUs = Math.max(1, Math.round(1_000_000 / this.outputFps));
    for (const source of scene.sources) {
      const entry = this.entries.get(source.node.id);
      if (!entry) throw new Error(`canonical media source is not loaded: ${source.node.id}`);
      const durationUs = entry.handle.duration_us;
      const maxPtsUs =
        durationUs == null ? Number.POSITIVE_INFINITY : Math.max(0, durationUs - frameDurationUs);
      const sourcePtsUs = Math.max(0, Math.min(source.source_pts_us, maxPtsUs));
      if (entry.last_source_pts_us === sourcePtsUs) continue;
      await entry.handle.seek(sourcePtsUs, {
        last_frame: source.held,
        frame_duration_us: frameDurationUs,
      });
      entry.last_source_pts_us = sourcePtsUs;
    }
  }

  source(sourceId: string): CanvasImageSource | null {
    return this.entries.get(sourceId)?.handle.source ?? null;
  }

  loadedSourceIds(): string[] {
    return Array.from(this.entries.keys());
  }

  dispose(): void {
    this.generation += 1;
    this.disposeEntries();
  }

  private disposeEntries(): void {
    for (const entry of this.entries.values()) entry.handle.dispose();
    this.entries.clear();
  }
}

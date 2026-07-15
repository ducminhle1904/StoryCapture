import type { ExportCompositionGraphV4 } from "@storycapture/shared-types";

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

export type CanonicalMediaLoader = (node: ExportSourceNode) => Promise<CanonicalMediaHandle>;

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
      const clampedUs = Math.max(
        0,
        Math.min(sourcePtsUs, options.last_frame ? terminalUs : (durationUs ?? sourcePtsUs)),
      );
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

/**
 * Owns every source independently. It intentionally seeks in stable graph
 * order: parallel seeks make browser completion order observable and caused
 * nondeterministic frames in the legacy single-video implementation.
 */
export class CanonicalMediaSourcePool {
  private entries = new Map<string, PoolEntry>();
  private generation = 0;
  private outputFps = 60;

  constructor(private readonly loader: CanonicalMediaLoader = loadDomMediaSource) {}

  async configure(graph: ExportCompositionGraphV4): Promise<void> {
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
        const handle = await this.loader(node);
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
        durationUs == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, durationUs - (source.held ? frameDurationUs : 0));
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

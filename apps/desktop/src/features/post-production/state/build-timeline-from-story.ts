/**
 * Phase 19-03 — pure producer that turns a story + recording + trajectory
 * sidecar into the initial set of timeline clips.
 *
 * v1 scope:
 *   - 1 VideoClip from the recording.
 *   - 1 CursorClip when a trajectory sidecar is available.
 *   - ZoomClips from clicked trajectory frames.
 *   - Annotation tracks remain user-driven in v1.
 *
 * Determinism: identical input ⇒ identical output. Clip ids derive from
 * the recording path via FNV-1a, so consumers can rely on stable
 * identity across re-runs.
 */
import type { ParseResult } from "@/ipc/parse";
import type { RecordingTrajectory } from "@/ipc/trajectory";
import type { RecordingActions } from "@/ipc/actions";
import type { RecordingInfo } from "@/ipc/projects";
import type { CursorClip, VideoClip, ZoomClip } from "../state/timeline-slice";

export interface BuildTimelineInput {
  /** Parsed story DTO. May be null when parsing failed; we still emit a video clip. */
  story: ParseResult | null;
  recording: RecordingInfo;
  /** Trajectory sidecar (Phase 19-02). Null when the sidecar is missing. */
  trajectory: RecordingTrajectory | null;
  /** Semantic actions sidecar. Preferred over legacy OS cursor trajectory. */
  actions?: RecordingActions | null;
}

export interface BuildTimelineOutput {
  video: VideoClip[];
  cursor: CursorClip[];
  zoom: ZoomClip[];
}

const FALLBACK_DURATION_MS = 60_000;
const AUTO_ZOOM_PRE_ROLL_MS = 200;
const AUTO_ZOOM_DURATION_MS = 800;
const AUTO_ZOOM_DEBOUNCE_MS = 800;
const AUTO_ZOOM_SCALE = 1.3;

/** Short, deterministic FNV-1a-derived identifier for a path. */
function hashPath(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Replace the trailing `.mp4` (case-insensitive) with `.trajectory.json`. */
function deriveTrajectoryPath(recordingPath: string): string {
  return recordingPath.replace(/\.mp4$/i, ".trajectory.json");
}

function deriveActionsPath(recordingPath: string): string {
  return recordingPath.replace(/\.mp4$/i, ".actions.json");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function normalizeCenter(
  rect: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0.5, y: 0.5 };
  }
  return {
    x: clamp01((x - rect.x) / rect.width),
    y: clamp01((y - rect.y) / rect.height),
  };
}

function buildAutoZoomClips(
  trajectory: RecordingTrajectory | null,
  actions: RecordingActions | null,
  idBase: string,
): ZoomClip[] {
  if (actions) {
    return actions.events
      .filter(
        (event) => event.target && (event.verb === "click" || event.pointer?.effect === "click"),
      )
      .map((event) => ({
        id: `zoom-${idBase}-${event.t_action_ms}`,
        trackId: "zoom" as const,
        startMs: Math.max(0, event.t_action_ms - AUTO_ZOOM_PRE_ROLL_MS),
        durationMs: AUTO_ZOOM_DURATION_MS,
        label: "Auto zoom",
        target: { kind: "cursor" as const },
        scale: AUTO_ZOOM_SCALE,
        center: normalizeCenter(
          actions.capture_rect,
          event.target!.center.x,
          event.target!.center.y,
        ),
        preset: "CALM" as const,
      }));
  }
  if (!trajectory) return [];

  const zoom: ZoomClip[] = [];
  let lastEmittedClickMs = Number.NEGATIVE_INFINITY;

  for (const frame of trajectory.frames) {
    if (!frame.click) continue;
    if (frame.t_ms - lastEmittedClickMs < AUTO_ZOOM_DEBOUNCE_MS) continue;

    lastEmittedClickMs = frame.t_ms;
    zoom.push({
      id: `zoom-${idBase}-${frame.t_ms}`,
      trackId: "zoom",
      startMs: Math.max(0, frame.t_ms - AUTO_ZOOM_PRE_ROLL_MS),
      durationMs: AUTO_ZOOM_DURATION_MS,
      label: "Auto zoom",
      target: { kind: "cursor" },
      scale: AUTO_ZOOM_SCALE,
      center: normalizeCenter(trajectory.capture_rect, frame.x, frame.y),
      preset: "CALM",
    });
  }

  return zoom;
}

function cursorSidecarFor(
  recordingPath: string,
  actions: RecordingActions | null,
  trajectory: RecordingTrajectory | null,
  durationMs: number,
): { path: string; fps: number; frameCount: number } | null {
  if (actions) {
    const fps = actions.fps > 0 ? actions.fps : 60;
    const durationFrameCount = Math.ceil((Math.max(0, durationMs) / 1000) * fps);
    return {
      path: deriveActionsPath(recordingPath),
      fps,
      frameCount: Math.max(actions.frame_count, durationFrameCount, 1),
    };
  }
  if (!trajectory) return null;
  return {
    path: deriveTrajectoryPath(recordingPath),
    fps: trajectory.fps,
    frameCount: trajectory.frame_count,
  };
}

export function buildTimelineFromStory(input: BuildTimelineInput): BuildTimelineOutput {
  // Story is intentionally unused in v1 — annotations remain user-driven.
  // We accept it now so the signature is stable for future producers.
  void input.story;

  const { recording, trajectory } = input;
  const actions = input.actions ?? null;
  const idBase = hashPath(recording.path);

  let durationMs = recording.duration_ms ?? 0;
  if (durationMs <= 0 && actions && actions.fps > 0) {
    durationMs = Math.round((actions.frame_count / actions.fps) * 1000);
  }
  if (durationMs <= 0 && trajectory && trajectory.fps > 0) {
    durationMs = Math.round((trajectory.frame_count / trajectory.fps) * 1000);
  }
  if (durationMs <= 0) {
    durationMs = FALLBACK_DURATION_MS;
  }

  const video: VideoClip[] = [
    {
      id: `video-${idBase}`,
      trackId: "video",
      startMs: 0,
      durationMs,
      sourcePath: recording.path,
      label: basename(recording.path),
    },
  ];

  const cursor: CursorClip[] = [];
  const cursorSidecar = cursorSidecarFor(recording.path, actions, trajectory, durationMs);
  if (cursorSidecar) {
    cursor.push({
      id: `cursor-${idBase}`,
      trackId: "cursor",
      startMs: 0,
      durationMs,
      trajectoryDir: cursorSidecar.path,
      trajectoryFps: cursorSidecar.fps,
      trajectoryFrameCount: cursorSidecar.frameCount,
      skin: "mac-default",
      sizeScale: 1.0,
    });
  }

  const zoom = buildAutoZoomClips(trajectory, actions, idBase);

  return { video, cursor, zoom };
}

/**
 * Phase 19-03 — pure producer that turns a story + recording + trajectory
 * sidecar into the initial set of timeline clips.
 *
 * v1 scope:
 *   - 1 VideoClip from the recording.
 *   - 1 CursorClip when a trajectory sidecar is available.
 *   - Zoom and annotation tracks are intentionally NOT auto-populated;
 *     they remain user-driven in v1 (see Phase 19 PLAN D-2/D-3).
 *
 * Determinism: identical input ⇒ identical output. Clip ids derive from
 * the recording path via FNV-1a, so consumers can rely on stable
 * identity across re-runs.
 */
import type { ParseResult } from "@/ipc/parse";
import type { RecordingTrajectory } from "@/ipc/trajectory";
import type { RecordingInfo } from "@/ipc/projects";
import type { CursorClip, VideoClip } from "../state/timeline-slice";

export interface BuildTimelineInput {
  /** Parsed story DTO. May be null when parsing failed; we still emit a video clip. */
  story: ParseResult | null;
  recording: RecordingInfo;
  /** Trajectory sidecar (Phase 19-02). Null when the sidecar is missing. */
  trajectory: RecordingTrajectory | null;
}

export interface BuildTimelineOutput {
  video: VideoClip[];
  cursor: CursorClip[];
}

const FALLBACK_DURATION_MS = 60_000;

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

export function buildTimelineFromStory(
  input: BuildTimelineInput,
): BuildTimelineOutput {
  // Story is intentionally unused in v1 — auto-zoom & annotations are
  // deferred. We accept it now so the signature is stable for Phase 19.5.
  void input.story;

  const { recording, trajectory } = input;
  const idBase = hashPath(recording.path);

  let durationMs = recording.duration_ms ?? 0;
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
  if (trajectory) {
    cursor.push({
      id: `cursor-${idBase}`,
      trackId: "cursor",
      startMs: 0,
      durationMs,
      trajectoryDir: deriveTrajectoryPath(recording.path),
      trajectoryFps: trajectory.fps,
      trajectoryFrameCount: trajectory.frame_count,
      skin: "mac-default",
      sizeScale: 1.0,
    });
  }

  return { video, cursor };
}

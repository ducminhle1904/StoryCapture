import { parseActionSidecar, type RecordingActions } from "@/ipc/action-sidecar";
import type { RecordingTrajectory } from "@/ipc/trajectory";

export type ParsedExportCursorSidecar =
  | { kind: "actions"; sidecar: RecordingActions }
  | { kind: "trajectory"; sidecar: RecordingTrajectory }
  | { kind: "unknown"; sidecar: null };

function isRecordingTrajectory(value: unknown): value is RecordingTrajectory {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as RecordingTrajectory).frames),
  );
}

export function parseExportCursorSidecar(value: unknown): ParsedExportCursorSidecar {
  const actions = parseActionSidecar(value);
  if (actions) return { kind: "actions", sidecar: actions };
  if (isRecordingTrajectory(value)) return { kind: "trajectory", sidecar: value };
  return { kind: "unknown", sidecar: null };
}

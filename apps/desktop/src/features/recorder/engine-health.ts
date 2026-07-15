import type { EngineHealthSnapshotDto } from "@/ipc/encode";

export interface RecorderEngineHealthState {
  sessionId: string | null;
  sequence: number;
  snapshot: EngineHealthSnapshotDto | null;
}

export const initialRecorderEngineHealthState: RecorderEngineHealthState = {
  sessionId: null,
  sequence: 0,
  snapshot: null,
};

export function reduceRecorderEngineHealth(
  current: RecorderEngineHealthState,
  activeSessionId: string,
  snapshot: EngineHealthSnapshotDto,
): RecorderEngineHealthState {
  if (snapshot.session_id !== activeSessionId) return current;
  if (current.sessionId === activeSessionId && snapshot.sequence <= current.sequence)
    return current;
  return {
    sessionId: activeSessionId,
    sequence: snapshot.sequence,
    snapshot,
  };
}

export function engineHealthCopy(snapshot: EngineHealthSnapshotDto): {
  label: string;
  summary: string;
  severity: "neutral" | "success" | "warning" | "danger";
  persistent: boolean;
} {
  const primaryReason = snapshot.reason_codes[0]?.replaceAll("_", " ") ?? null;
  switch (snapshot.state) {
    case "starting":
      return {
        label: "Engine starting",
        summary: "Waiting for committed media progress",
        severity: "neutral",
        persistent: false,
      };
    case "healthy":
      return {
        label: "Engine healthy",
        summary: `${snapshot.actual_capture_fps.toFixed(1)} fps · ${snapshot.frames_dropped + snapshot.skipped_ticks} lost`,
        severity: "success",
        persistent: false,
      };
    case "constrained":
      return {
        label: "Engine constrained",
        summary: primaryReason ?? "Capture is under sustained pressure",
        severity: "warning",
        persistent: false,
      };
    case "degraded":
      return {
        label: "Engine degraded",
        summary: primaryReason ?? "A recording invariant is degraded",
        severity: "danger",
        persistent: true,
      };
    case "stalled":
      return {
        label: "Engine stalled",
        summary: primaryReason ?? "Committed recording progress stopped",
        severity: "danger",
        persistent: true,
      };
    case "stopping":
      return {
        label: "Engine stopping",
        summary: "Draining and validating recorded media",
        severity: "neutral",
        persistent: false,
      };
  }
}

export function formatEngineHealthBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
}

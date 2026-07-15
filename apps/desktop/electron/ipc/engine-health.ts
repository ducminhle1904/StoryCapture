import type { RecordingHealthUpdateV1, RecordingHealthV1 } from "./recording-health";
import {
  RECORDING_PREFLIGHT_DISK_BLOCK_BYTES,
  RECORDING_PREFLIGHT_DISK_WARN_BYTES,
} from "./recording-preflight";

export type EngineHealthMode = "off" | "shadow" | "internal" | "beta" | "ga";
export type EngineHealthState =
  | "starting"
  | "healthy"
  | "constrained"
  | "degraded"
  | "stalled"
  | "stopping";

export interface EngineHealthAudioTrack {
  track_id: string;
  role: "microphone" | "tab" | "system";
  requirement: "required" | "optional";
  state: "not_requested" | "starting" | "healthy" | "silent" | "failed" | "stopped";
  samples_received: number;
  last_sample_pts_us: number | null;
  terminal_reason: string | null;
}

export interface EngineHealthSnapshot {
  schema_version: 1;
  session_id: string;
  sequence: number;
  observed_at_ms: number;
  state: EngineHealthState;
  reason_codes: string[];
  requested_fps: number;
  effective_fps: number;
  actual_capture_fps: number;
  source_capture_fps: number;
  committed_frames: number;
  source_frames_received: number;
  frames_dropped: number;
  skipped_ticks: number;
  late_frames: number;
  encoder_backpressured: boolean;
  encoder_backpressure_events: number;
  capture_duration_ms_p95: number | null;
  last_committed_pts_us: number | null;
  encoder_alive: boolean;
  audio_tracks: EngineHealthAudioTrack[];
  target_liveness: {
    state: "unknown" | "live" | "stale" | "lost";
    last_observed_at_ms: number | null;
    reason: string | null;
  };
  disk: {
    free_bytes: number;
    threshold_bytes: number;
    state: "ok" | "low" | "critical";
  };
  terminal_health: {
    state: "none" | "healthy" | "repairable" | "fatal";
    reason_codes: string[];
  };
  allowed_actions: Array<"stop" | "cancel" | "repair">;
}

export interface EngineHealthInput {
  sessionId: string;
  observedAtMs: number;
  lifecycle: "recording" | "paused" | "stopping" | "finalized";
  healthUpdate: RecordingHealthUpdateV1;
  effectiveFps: number;
  sourceCaptureFps: number;
  sourceFramesReceived: number;
  lateFrames: number;
  encoderBackpressured: boolean;
  encoderBackpressureEvents: number;
  captureDurationMsP95: number | null;
  lastCommittedPtsUs: number | null;
  encoderAlive: boolean;
  audioTracks: EngineHealthAudioTrack[];
  targetLiveness: EngineHealthSnapshot["target_liveness"];
  diskFreeBytes: number;
  terminalHealth: EngineHealthSnapshot["terminal_health"];
  repairAvailable: boolean;
}

const STATE_RANK: Record<EngineHealthState, number> = {
  starting: 0,
  healthy: 1,
  constrained: 2,
  degraded: 3,
  stalled: 4,
  stopping: 0,
};

export function engineHealthMode(): EngineHealthMode {
  const value = process.env.STORYCAPTURE_RECORDING_HEALTH_HUD_MODE?.trim().toLowerCase();
  if (value === "shadow" || value === "internal" || value === "beta" || value === "ga") {
    return value;
  }
  return "off";
}

function diskState(freeBytes: number): EngineHealthSnapshot["disk"] {
  if (freeBytes < RECORDING_PREFLIGHT_DISK_BLOCK_BYTES) {
    return {
      free_bytes: freeBytes,
      threshold_bytes: RECORDING_PREFLIGHT_DISK_BLOCK_BYTES,
      state: "critical",
    };
  }
  if (freeBytes < RECORDING_PREFLIGHT_DISK_WARN_BYTES) {
    return {
      free_bytes: freeBytes,
      threshold_bytes: RECORDING_PREFLIGHT_DISK_WARN_BYTES,
      state: "low",
    };
  }
  return {
    free_bytes: freeBytes,
    threshold_bytes: RECORDING_PREFLIGHT_DISK_WARN_BYTES,
    state: "ok",
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function classifyEngineHealth(
  input: EngineHealthInput,
  sequence: number,
): EngineHealthSnapshot {
  const health = input.healthUpdate.health;
  const disk = diskState(input.diskFreeBytes);
  const reasons = [...health.reasons, ...input.terminalHealth.reason_codes];
  const requiredTrackFailed = input.audioTracks.some(
    (track) => track.requirement === "required" && track.state === "failed",
  );
  const optionalTrackFailed = input.audioTracks.some(
    (track) => track.requirement === "optional" && track.state === "failed",
  );
  if (!input.encoderAlive) reasons.push("encoder_not_alive");
  if (input.targetLiveness.state === "lost") reasons.push("target_lost");
  if (disk.state === "critical") reasons.push("disk_critical");
  if (disk.state === "low") reasons.push("disk_low");
  if (requiredTrackFailed) reasons.push("required_audio_failed");
  if (optionalTrackFailed) reasons.push("optional_audio_failed");
  if (input.encoderBackpressured) reasons.push("encoder_backpressured");

  let state: EngineHealthState;
  if (input.lifecycle === "stopping" || input.lifecycle === "finalized") state = "stopping";
  else if (
    !input.encoderAlive ||
    input.targetLiveness.state === "lost" ||
    input.terminalHealth.state === "fatal"
  ) {
    state = "stalled";
  } else if (
    health.verdict === "fail" ||
    input.terminalHealth.state === "repairable" ||
    disk.state === "critical" ||
    requiredTrackFailed
  ) {
    state = "degraded";
  } else if (
    health.verdict === "degraded" ||
    disk.state === "low" ||
    optionalTrackFailed ||
    input.encoderBackpressured
  ) {
    state = "constrained";
  } else if (health.encoded_frames === 0) state = "starting";
  else state = "healthy";

  const allowedActions: EngineHealthSnapshot["allowed_actions"] = [];
  if (input.lifecycle === "recording" || input.lifecycle === "paused") {
    allowedActions.push("stop", "cancel");
    if (input.repairAvailable && input.terminalHealth.state === "repairable") {
      allowedActions.push("repair");
    }
  }
  return {
    schema_version: 1,
    session_id: input.sessionId,
    sequence,
    observed_at_ms: input.observedAtMs,
    state,
    reason_codes: unique(reasons),
    requested_fps: health.requested_fps,
    effective_fps: input.effectiveFps,
    actual_capture_fps: health.observed_fps ?? 0,
    source_capture_fps: input.sourceCaptureFps,
    committed_frames: health.encoded_frames,
    source_frames_received: input.sourceFramesReceived,
    frames_dropped: health.dropped_frames,
    skipped_ticks: health.skipped_frames,
    late_frames: input.lateFrames,
    encoder_backpressured: input.encoderBackpressured,
    encoder_backpressure_events: input.encoderBackpressureEvents,
    capture_duration_ms_p95: input.captureDurationMsP95,
    last_committed_pts_us: input.lastCommittedPtsUs,
    encoder_alive: input.encoderAlive,
    audio_tracks: input.audioTracks.map((track) => ({ ...track })),
    target_liveness: { ...input.targetLiveness },
    disk,
    terminal_health: {
      state: input.terminalHealth.state,
      reason_codes: unique(input.terminalHealth.reason_codes),
    },
    allowed_actions: allowedActions,
  };
}

export interface EngineHealthEvidence {
  version: 1;
  latest: EngineHealthSnapshot;
  peak_state: EngineHealthState;
  reason_codes: string[];
}

export class EngineHealthPublisher {
  #sequence = 0;
  #lastEmittedAtMs = -Infinity;
  #latest: EngineHealthSnapshot | null = null;
  #peakState: EngineHealthState = "starting";
  #reasons = new Set<string>();

  update(input: EngineHealthInput, force = false): EngineHealthSnapshot | null {
    const candidate = classifyEngineHealth(input, this.#sequence + 1);
    const transition =
      !this.#latest ||
      candidate.state !== this.#latest.state ||
      candidate.reason_codes.join("|") !== this.#latest.reason_codes.join("|") ||
      candidate.encoder_backpressured !== this.#latest.encoder_backpressured;
    if (!force && !transition && input.observedAtMs - this.#lastEmittedAtMs < 1_000) return null;
    this.#sequence += 1;
    candidate.sequence = this.#sequence;
    this.#lastEmittedAtMs = input.observedAtMs;
    this.#latest = candidate;
    if (STATE_RANK[candidate.state] > STATE_RANK[this.#peakState])
      this.#peakState = candidate.state;
    for (const reason of candidate.reason_codes) this.#reasons.add(reason);
    return candidate;
  }

  evidence(): EngineHealthEvidence | null {
    if (!this.#latest) return null;
    return {
      version: 1,
      latest: this.#latest,
      peak_state: this.#peakState,
      reason_codes: [...this.#reasons].sort(),
    };
  }
}

class EngineHealthRegistry {
  readonly #publishers = new Map<string, EngineHealthPublisher>();

  register(sessionId: string): EngineHealthPublisher {
    const publisher = new EngineHealthPublisher();
    this.#publishers.set(sessionId, publisher);
    if (this.#publishers.size > 64) {
      const oldest = this.#publishers.keys().next().value;
      if (typeof oldest === "string" && oldest !== sessionId) this.#publishers.delete(oldest);
    }
    return publisher;
  }

  get(sessionId: string): EngineHealthPublisher | null {
    return this.#publishers.get(sessionId) ?? null;
  }

  remove(sessionId: string): void {
    this.#publishers.delete(sessionId);
  }
}

export const engineHealth = new EngineHealthRegistry();

export function engineHealthInputFromRecording(
  session: {
    id: string;
    startedAt: number;
    lifecycle: EngineHealthInput["lifecycle"];
    effectiveFps: number;
    sourceFramesReceived: number;
    lateFrames: number;
    encoderBackpressured: boolean;
    encoderBackpressureEvents: number;
    captureDurationMs: number[];
    mediaClock: { snapshot(): { frameCount: number; durationUs: number } };
    encoderError: Error | null;
  },
  healthUpdate: RecordingHealthUpdateV1,
  options: {
    observedAtMs: number;
    diskFreeBytes: number;
    targetLive: boolean;
    audioTracks?: EngineHealthAudioTrack[];
    terminalHealth?: EngineHealthSnapshot["terminal_health"];
    repairAvailable?: boolean;
  },
): EngineHealthInput {
  const elapsedSeconds = Math.max(0.001, (options.observedAtMs - session.startedAt) / 1_000);
  const sortedDurations = [...session.captureDurationMs].sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
  const clock = session.mediaClock.snapshot();
  return {
    sessionId: session.id,
    observedAtMs: options.observedAtMs,
    lifecycle: session.lifecycle,
    healthUpdate,
    effectiveFps: session.effectiveFps,
    sourceCaptureFps: session.sourceFramesReceived / elapsedSeconds,
    sourceFramesReceived: session.sourceFramesReceived,
    lateFrames: session.lateFrames,
    encoderBackpressured: session.encoderBackpressured,
    encoderBackpressureEvents: session.encoderBackpressureEvents,
    captureDurationMsP95: sortedDurations[p95Index] ?? null,
    lastCommittedPtsUs: clock.frameCount > 0 ? clock.durationUs : null,
    encoderAlive: session.encoderError == null,
    audioTracks: options.audioTracks ?? [],
    targetLiveness: {
      state: options.targetLive ? "live" : "lost",
      last_observed_at_ms: options.observedAtMs,
      reason: options.targetLive ? null : "target_destroyed",
    },
    diskFreeBytes: options.diskFreeBytes,
    terminalHealth: options.terminalHealth ?? { state: "none", reason_codes: [] },
    repairAvailable: options.repairAvailable ?? false,
  };
}

export function healthUpdateHealth(update: RecordingHealthUpdateV1): RecordingHealthV1 {
  return update.health;
}

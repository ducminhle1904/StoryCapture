import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WebFrameMain } from "electron";
import { recordEngineLog } from "./recording-observability";

export type RecordingAudioMode =
  | "legacy"
  | "multitrack_shadow"
  | "multitrack_internal"
  | "multitrack_beta"
  | "multitrack_ga";
export type AudioTrackRole = "microphone" | "tab" | "system";
export type AudioTrackRequirement = "required" | "optional";
export type AudioTrackStatus = "requested" | "started" | "completed" | "failed" | "not_requested";
export type AudioTrackSourceKind = "media_device" | "author_preview_frame" | "platform_system";

export interface RecordingAudioTrackRequest {
  track_id: string;
  role: AudioTrackRole;
  requirement: AudioTrackRequirement;
  source_id: string | null;
  capture_token: string;
}

export interface RecordingAudioTrackDescriptor {
  schema_version: 1;
  track_id: string;
  role: AudioTrackRole;
  requirement: AudioTrackRequirement;
  source_kind: AudioTrackSourceKind;
  source_id: string | null;
  relative_path: string | null;
  container: string | null;
  codec: string | null;
  sample_rate_hz: number | null;
  channels: number | null;
  first_pts_us: number | null;
  last_pts_us: number | null;
  duration_us: number;
  discontinuity_count: number;
  status: AudioTrackStatus;
  failure_reason: string | null;
}

interface TrackRuntime {
  request: RecordingAudioTrackRequest;
  descriptor: RecordingAudioTrackDescriptor;
  nextSequence: number;
  totalBytes: number;
  totalChunks: number;
  terminal: boolean;
}

interface SessionRuntime {
  targetKind: string;
  originMonotonicEpochMs: number;
  tracks: Map<string, TrackRuntime>;
}

export interface RecordingAudioTrackEventIdentity {
  session_id: string;
  track_id: string;
  role: AudioTrackRole;
  source_id: string | null;
  capture_token: string;
}

const AUDIO_MODES = new Set<RecordingAudioMode>([
  "legacy",
  "multitrack_shadow",
  "multitrack_internal",
  "multitrack_beta",
  "multitrack_ga",
]);

export function recordingAudioMode(
  raw = process.env.STORYCAPTURE_RECORDING_AUDIO_MODE,
): RecordingAudioMode {
  return AUDIO_MODES.has(raw as RecordingAudioMode) ? (raw as RecordingAudioMode) : "legacy";
}

export function createRecordingAudioTrackRequest(
  input: Omit<RecordingAudioTrackRequest, "track_id" | "capture_token"> & {
    track_id?: string;
    capture_token?: string;
  },
): RecordingAudioTrackRequest {
  return {
    ...input,
    track_id: input.track_id || randomUUID(),
    capture_token: input.capture_token || randomUUID(),
  };
}

function sourceKind(role: AudioTrackRole): AudioTrackSourceKind {
  if (role === "microphone") return "media_device";
  if (role === "tab") return "author_preview_frame";
  return "platform_system";
}

export function validateRecordingAudioSelection(
  targetKind: string,
  requests: readonly RecordingAudioTrackRequest[],
): void {
  const roles = new Set<AudioTrackRole>();
  const ids = new Set<string>();
  for (const request of requests) {
    if (!request.track_id || !request.capture_token) {
      throw new Error("audio track identity and capture token are required");
    }
    if (request.requirement !== "required" && request.requirement !== "optional") {
      throw new Error(`audio track ${request.track_id} requirement is invalid`);
    }
    if (roles.has(request.role)) throw new Error(`duplicate audio role ${request.role}`);
    if (ids.has(request.track_id)) throw new Error(`duplicate audio track ${request.track_id}`);
    roles.add(request.role);
    ids.add(request.track_id);
  }
  if (targetKind === "author_preview" && roles.has("system")) {
    throw new Error("system audio is forbidden for author_preview");
  }
  if (targetKind !== "author_preview" && roles.has("tab")) {
    throw new Error("tab audio requires author_preview");
  }
  if (roles.has("tab") && roles.has("system")) {
    throw new Error("tab and system audio cannot be armed together");
  }
}

export function recordingCompatibilityMixArgs(input: {
  stems: readonly { path: string; firstPtsUs: number | null }[];
  outputPath: string;
  videoDurationUs: number;
}): string[] {
  if (input.stems.length === 0) throw new Error("compatibility mix requires at least one stem");
  const durationSeconds = Math.max(0.001, input.videoDurationUs / 1_000_000).toFixed(6);
  const args = ["-y"];
  for (const stem of input.stems) args.push("-i", stem.path);
  const filters = input.stems.map((stem, index) => {
    const delayMs = Math.max(0, Math.round((stem.firstPtsUs ?? 0) / 1_000));
    return `[${index}:a]adelay=delays=${delayMs}:all=1,apad[a${index}]`;
  });
  if (input.stems.length === 1) {
    filters.push(`[a0]atrim=duration=${durationSeconds}[mix]`);
  } else {
    filters.push(
      `${input.stems.map((_, index) => `[a${index}]`).join("")}amix=inputs=${input.stems.length}:duration=longest:normalize=0,atrim=duration=${durationSeconds}[mix]`,
    );
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[mix]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    durationSeconds,
    input.outputPath,
  );
  return args;
}

export class RecordingAudioTrackRegistry {
  readonly #sessions = new Map<string, SessionRuntime>();

  register(input: {
    sessionId: string;
    targetKind: string;
    originMonotonicEpochMs: number;
    requests: readonly RecordingAudioTrackRequest[];
  }): readonly RecordingAudioTrackDescriptor[] {
    if (this.#sessions.has(input.sessionId)) {
      throw new Error(`audio tracks already registered for ${input.sessionId}`);
    }
    validateRecordingAudioSelection(input.targetKind, input.requests);
    const tracks = new Map<string, TrackRuntime>();
    for (const request of input.requests) {
      tracks.set(request.track_id, {
        request: { ...request },
        descriptor: {
          schema_version: 1,
          track_id: request.track_id,
          role: request.role,
          requirement: request.requirement,
          source_kind: sourceKind(request.role),
          source_id: request.source_id,
          relative_path: null,
          container: null,
          codec: null,
          sample_rate_hz: null,
          channels: null,
          first_pts_us: null,
          last_pts_us: null,
          duration_us: 0,
          discontinuity_count: 0,
          status: "requested",
          failure_reason: null,
        },
        nextSequence: 0,
        totalBytes: 0,
        totalChunks: 0,
        terminal: false,
      });
    }
    this.#sessions.set(input.sessionId, {
      targetKind: input.targetKind,
      originMonotonicEpochMs: input.originMonotonicEpochMs,
      tracks,
    });
    return this.descriptors(input.sessionId);
  }

  authenticate(identity: RecordingAudioTrackEventIdentity): TrackRuntime {
    const session = this.#sessions.get(identity.session_id);
    if (!session) throw new Error(`audio track session ${identity.session_id} is stale`);
    const track = session.tracks.get(identity.track_id);
    if (!track) throw new Error(`audio track ${identity.track_id} is not registered`);
    if (
      track.request.capture_token !== identity.capture_token ||
      track.request.role !== identity.role ||
      track.request.source_id !== identity.source_id
    ) {
      throw new Error(`audio track ${identity.track_id} identity mismatch`);
    }
    return track;
  }

  begin(
    identity: RecordingAudioTrackEventIdentity,
    input: {
      sequence: number;
      relativePath: string;
      container: string;
      codec?: string | null;
      sampleRateHz?: number | null;
      channels?: number | null;
    },
  ): RecordingAudioTrackDescriptor {
    const track = this.authenticate(identity);
    this.#assertSequence(track, input.sequence);
    if (track.terminal) throw new Error(`audio track ${identity.track_id} is terminal`);
    if (track.descriptor.status === "started") return { ...track.descriptor };
    if (track.descriptor.status !== "requested") {
      throw new Error(
        `audio track ${identity.track_id} cannot begin from ${track.descriptor.status}`,
      );
    }
    Object.assign(track.descriptor, {
      relative_path: input.relativePath,
      container: input.container,
      codec: input.codec ?? null,
      sample_rate_hz: input.sampleRateHz ?? null,
      channels: input.channels ?? null,
      status: "started" as const,
    });
    void recordEngineLog({
      event: "recording.audio.track_state_changed",
      context: {
        session_id: identity.session_id,
        track_id: identity.track_id,
        phase: "started",
        artifact_relpath: input.relativePath,
      },
      details: {
        role: identity.role,
        requirement: track.descriptor.requirement,
        previous_state: "requested",
        state: "started",
      },
    });
    return { ...track.descriptor };
  }

  chunk(
    identity: RecordingAudioTrackEventIdentity,
    input: {
      sequence: number;
      byteLength: number;
      ptsUs?: number | null;
      monotonicEpochMs: number;
      durationUs: number;
    },
  ): RecordingAudioTrackDescriptor {
    const session = this.#sessions.get(identity.session_id);
    const track = this.authenticate(identity);
    this.#assertSequence(track, input.sequence);
    if (track.terminal || track.descriptor.status !== "started") {
      throw new Error(`audio track ${identity.track_id} is not writable`);
    }
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
      throw new Error("audio chunk byte length must be positive");
    }
    const rebasedPtsUs = Math.max(
      0,
      Math.round(
        input.ptsUs ?? (input.monotonicEpochMs - (session?.originMonotonicEpochMs ?? 0)) * 1_000,
      ),
    );
    const durationUs = Math.max(0, Math.round(input.durationUs));
    const firstSample = track.totalChunks === 0;
    track.totalBytes += input.byteLength;
    track.totalChunks += 1;
    track.descriptor.first_pts_us ??= rebasedPtsUs;
    track.descriptor.last_pts_us = Math.max(rebasedPtsUs + durationUs, rebasedPtsUs);
    track.descriptor.duration_us = Math.max(
      track.descriptor.duration_us,
      track.descriptor.last_pts_us - track.descriptor.first_pts_us,
    );
    if (firstSample) {
      void recordEngineLog({
        event: "recording.audio.track_state_changed",
        context: {
          session_id: identity.session_id,
          track_id: identity.track_id,
          phase: "first_sample",
        },
        details: {
          role: identity.role,
          first_pts_us: track.descriptor.first_pts_us,
        },
      });
    }
    return { ...track.descriptor };
  }

  control(
    identity: RecordingAudioTrackEventIdentity,
    sequence: number,
    operation: "pause" | "resume",
  ): void {
    const track = this.authenticate(identity);
    this.#assertSequence(track, sequence);
    if (track.terminal) throw new Error(`audio track ${identity.track_id} is terminal`);
    if (operation === "resume") {
      track.descriptor.discontinuity_count += 1;
      void recordEngineLog({
        level: "warn",
        event: "recording.audio.track_state_changed",
        context: {
          session_id: identity.session_id,
          track_id: identity.track_id,
          phase: "resumed",
        },
        details: {
          role: identity.role,
          discontinuity_count: track.descriptor.discontinuity_count,
        },
      });
    }
  }

  complete(
    identity: RecordingAudioTrackEventIdentity,
    input: { sequence: number; totalBytes: number; totalChunks: number },
  ): RecordingAudioTrackDescriptor {
    const track = this.authenticate(identity);
    this.#assertSequence(track, input.sequence);
    if (track.terminal) return { ...track.descriptor };
    if (input.totalBytes !== track.totalBytes || input.totalChunks !== track.totalChunks) {
      throw new Error(`audio track ${identity.track_id} totals mismatch`);
    }
    track.terminal = true;
    if (track.totalBytes === 0 || track.totalChunks === 0) {
      track.descriptor.status = "failed";
      track.descriptor.failure_reason = "audio_zero_samples";
    } else {
      track.descriptor.status = "completed";
    }
    void recordEngineLog({
      level: track.descriptor.status === "failed" ? "warn" : "info",
      event: "recording.audio.track_state_changed",
      context: {
        session_id: identity.session_id,
        track_id: identity.track_id,
        phase: track.descriptor.status,
        reason_code: track.descriptor.failure_reason ?? undefined,
      },
      details: {
        role: identity.role,
        total_bytes: track.totalBytes,
        total_chunks: track.totalChunks,
        duration_us: track.descriptor.duration_us,
      },
    });
    return { ...track.descriptor };
  }

  fail(
    identity: RecordingAudioTrackEventIdentity,
    input: { sequence: number; reason: string },
  ): RecordingAudioTrackDescriptor {
    const track = this.authenticate(identity);
    this.#assertSequence(track, input.sequence);
    const transitioned = !track.terminal;
    if (!track.terminal) {
      track.terminal = true;
      track.descriptor.status = "failed";
      track.descriptor.failure_reason = input.reason || "audio_stream_aborted";
    }
    if (transitioned) {
      void recordEngineLog({
        level: "warn",
        event: "recording.audio.track_state_changed",
        context: {
          session_id: identity.session_id,
          track_id: identity.track_id,
          phase: "failed",
          reason_code: track.descriptor.failure_reason ?? undefined,
        },
        details: { role: identity.role },
      });
    }
    return { ...track.descriptor };
  }

  descriptors(sessionId: string): readonly RecordingAudioTrackDescriptor[] {
    const session = this.#sessions.get(sessionId);
    if (!session) return [];
    return [...session.tracks.values()]
      .map((track) => ({ ...track.descriptor }))
      .sort((left, right) => left.role.localeCompare(right.role));
  }

  request(sessionId: string, role: AudioTrackRole): RecordingAudioTrackRequest | null {
    const session = this.#sessions.get(sessionId);
    const track = [...(session?.tracks.values() ?? [])].find(
      (value) => value.request.role === role,
    );
    return track ? { ...track.request } : null;
  }

  requiredFailure(sessionId: string): boolean {
    return this.descriptors(sessionId).some(
      (track) => track.requirement === "required" && track.status === "failed",
    );
  }

  remove(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #assertSequence(track: TrackRuntime, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("audio sequence invalid");
    if (sequence !== track.nextSequence) {
      throw new Error(`audio sequence ${sequence} rejected; expected ${track.nextSequence}`);
    }
    track.nextSequence += 1;
  }
}

interface PendingTabGrant {
  sessionId: string;
  trackId: string;
  captureToken: string;
  requester: WebFrameMain;
  source: WebFrameMain;
  expiresAt: number;
}

export class AuthorPreviewTabGrantBroker {
  readonly #grants = new Map<string, PendingTabGrant>();

  arm(input: Omit<PendingTabGrant, "expiresAt"> & { ttlMs?: number }): void {
    this.#grants.set(input.sessionId, {
      ...input,
      expiresAt: Date.now() + (input.ttlMs ?? 10_000),
    });
  }

  consume(requester: WebFrameMain): PendingTabGrant | null {
    const now = Date.now();
    for (const [sessionId, grant] of this.#grants) {
      if (grant.expiresAt < now) {
        this.#grants.delete(sessionId);
        continue;
      }
      if (grant.requester !== requester) continue;
      this.#grants.delete(sessionId);
      return grant;
    }
    return null;
  }

  revoke(sessionId: string): void {
    this.#grants.delete(sessionId);
  }
}

export async function writeRecordingAudioDescriptors(
  filePath: string,
  sessionId: string,
  descriptors: readonly RecordingAudioTrackDescriptor[],
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    temporary,
    `${JSON.stringify({ schema_version: 1, session_id: sessionId, tracks: descriptors }, null, 2)}\n`,
    { flag: "wx" },
  );
  const handle = await fs.open(temporary, "r");
  await handle.sync().finally(() => handle.close());
  await fs.rename(temporary, filePath);
}

export const recordingAudioTracks = new RecordingAudioTrackRegistry();
export const authorPreviewTabGrants = new AuthorPreviewTabGrantBroker();

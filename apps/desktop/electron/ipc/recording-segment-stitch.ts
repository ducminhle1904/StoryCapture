import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { ActionTimelineEvent } from "./action-timeline";
import { recordingCompatibilityMixArgs } from "./audio-tracks";
import type { RecordingCheckpointAssemblySnapshot, StepCheckpoint } from "./recording-checkpoints";
import { recordEngineLog } from "./recording-observability";

export type RecordingAssemblyPath = "stream_copy" | "normalize";

export interface SegmentSelection {
  scene_id: string;
  scene_ordinal: number;
  attempt_id: string;
  media_path: string;
  media_sha256: string;
  resolution: { width: number; height: number };
  effective_fps: number;
  time_base: string;
  capture_backend: string;
  source_frame_range?: { start: number; end: number };
  source_pts_range_us?: { start: number; end: number };
}

export interface RecordingOutputSettings {
  width: number;
  height: number;
  fps: number;
  video_codec: "h264";
  pixel_format: "yuv420p";
  audio_codec: "aac";
  audio_sample_rate: number;
  audio_channel_layout: string;
}

export interface RecordingAssemblyAudioSource {
  role: string;
  requirement: "required" | "optional";
  media_path: string | null;
  media_sha256: string | null;
  first_pts_us: number;
}

export interface RecordingAssemblySpec {
  policy_version: 1;
  source_take_id: string;
  selections: SegmentSelection[];
  output: RecordingOutputSettings;
  required_tracks: string[];
  optional_tracks: string[];
  audio_sources?: RecordingAssemblyAudioSource[];
  toolchain: { ffmpeg: string };
}

export interface SegmentStreamProbe {
  duration_us: number;
  video: {
    codec: string;
    profile: string;
    pixel_format: string;
    color_metadata: string;
    width: number;
    height: number;
    effective_fps: number;
    time_base: string;
  };
  audio: Array<{
    role: string;
    codec: string;
    sample_rate: number;
    channel_layout: string;
  }>;
}

export interface RecordingRevision {
  policy_version: 1;
  revision_id: string;
  assembly_sha256: string;
  output_path: string;
  selected_attempts: SegmentSelection[];
  assembly_path: RecordingAssemblyPath;
  offset_map: SegmentOffset[];
  actions_path: string | null;
  checkpoints_path: string | null;
  audio_paths: Record<string, string>;
  compatibility_audio_path: string | null;
}

export interface SegmentOffset {
  scene_id: string;
  attempt_id: string;
  offset_us: number;
  duration_us: number;
  frame_offset: number;
  source_frame_start: number;
  source_pts_start_us: number;
}

export interface AssembleRecordingSegmentsOptions {
  takeRoot: string;
  spec: RecordingAssemblySpec;
  actionsByAttempt?: Record<string, ActionTimelineEvent[]>;
  checkpointsByAttempt?: Record<string, StepCheckpoint[]>;
  probe?: (mediaPath: string) => Promise<SegmentStreamProbe>;
  hashFile?: (mediaPath: string) => Promise<string>;
  runFfmpeg?: (args: string[]) => Promise<void>;
  failureInjector?: (stage: RecordingAssemblyFailureStage) => void | Promise<void>;
}

export interface PrepareLiveRepairAssemblyOptions {
  takeRoot: string;
  sourceTakeId: string;
  snapshot: RecordingCheckpointAssemblySnapshot;
  output: RecordingOutputSettings;
  captureBackend: string;
  audioSources?: RecordingAssemblyAudioSource[];
  toolchain: { ffmpeg: string };
  probe?: (mediaPath: string) => Promise<SegmentStreamProbe>;
  hashFile?: (mediaPath: string) => Promise<string>;
}

export interface PreparedLiveRepairAssembly {
  spec: RecordingAssemblySpec;
  actionsByAttempt: Record<string, ActionTimelineEvent[]>;
  checkpointsByAttempt: Record<string, StepCheckpoint[]>;
}

export type RecordingAssemblyFailureStage =
  | "inputs_validated"
  | "probed"
  | "ffmpeg_start"
  | "ffmpeg_complete"
  | "audio_assembled"
  | "sidecars_rebased"
  | "output_validated"
  | "before_commit";

export type RecordingAssemblyFailureReason =
  | "assembly_invalid"
  | "scene_selection_invalid"
  | "input_path_invalid"
  | "input_hash_mismatch"
  | "resolution_mismatch"
  | "fps_mismatch"
  | "time_base_mismatch"
  | "capture_backend_mismatch"
  | "required_audio_missing"
  | "stream_incompatible"
  | "probe_failed"
  | "ffmpeg_unavailable"
  | "ffmpeg_failed"
  | "sidecar_pts_invalid"
  | "output_validation_failed"
  | "revision_commit_failed";

export class RecordingAssemblyError extends Error {
  readonly recordingReasonCode = "segment_assembly_failed";

  constructor(
    readonly reason: RecordingAssemblyFailureReason,
    readonly details: Record<string, string | number | boolean | null> = {},
    cause?: unknown,
  ) {
    super(
      `recording_segment_assembly_failed:${reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "RecordingAssemblyError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalAssemblyJson(spec: RecordingAssemblySpec): string {
  return `${JSON.stringify(canonicalize(spec))}\n`;
}

export function recordingAssemblyDigest(spec: RecordingAssemblySpec): string {
  return createHash("sha256").update(canonicalAssemblyJson(spec)).digest("hex");
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function validateRecordingAssemblySpec(spec: RecordingAssemblySpec): void {
  if (
    spec.policy_version !== 1 ||
    !spec.source_take_id.trim() ||
    !finitePositive(spec.output.width) ||
    !finitePositive(spec.output.height) ||
    !finitePositive(spec.output.fps) ||
    spec.selections.length === 0
  ) {
    throw new RecordingAssemblyError("assembly_invalid");
  }
  const ordinals = new Set<number>();
  const scenes = new Set<string>();
  for (const [index, selection] of spec.selections.entries()) {
    if (
      selection.scene_ordinal !== index + 1 ||
      !selection.scene_id ||
      !selection.attempt_id ||
      !/^[a-f0-9]{64}$/.test(selection.media_sha256) ||
      (selection.source_frame_range != null &&
        (selection.source_frame_range.start < 0 ||
          selection.source_frame_range.end < selection.source_frame_range.start)) ||
      (selection.source_pts_range_us != null &&
        (selection.source_pts_range_us.start < 0 ||
          selection.source_pts_range_us.end < selection.source_pts_range_us.start)) ||
      ordinals.has(selection.scene_ordinal) ||
      scenes.has(selection.scene_id)
    ) {
      throw new RecordingAssemblyError("scene_selection_invalid", {
        scene_ordinal: selection.scene_ordinal,
      });
    }
    ordinals.add(selection.scene_ordinal);
    scenes.add(selection.scene_id);
  }
  if (spec.audio_sources) {
    const roles = new Set<string>();
    for (const source of spec.audio_sources) {
      if (
        !/^[a-z0-9_-]+$/.test(source.role) ||
        roles.has(source.role) ||
        !Number.isFinite(source.first_pts_us) ||
        source.first_pts_us < 0 ||
        (source.media_path === null) !== (source.media_sha256 === null) ||
        (source.media_sha256 !== null && !/^[a-f0-9]{64}$/.test(source.media_sha256))
      ) {
        throw new RecordingAssemblyError("assembly_invalid");
      }
      roles.add(source.role);
    }
    for (const role of spec.required_tracks) {
      const source = spec.audio_sources.find((candidate) => candidate.role === role);
      if (!source?.media_path || source.requirement !== "required") {
        throw new RecordingAssemblyError("required_audio_missing", { track: role });
      }
    }
  }
}

function exactNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON;
}

function audioByRole(probe: SegmentStreamProbe): Map<string, SegmentStreamProbe["audio"][number]> {
  return new Map(probe.audio.map((stream) => [stream.role, stream]));
}

export function classifySegmentCompatibility(
  spec: RecordingAssemblySpec,
  probes: SegmentStreamProbe[],
): RecordingAssemblyPath {
  if (probes.length !== spec.selections.length) {
    throw new RecordingAssemblyError("probe_failed", { expected: spec.selections.length });
  }
  let streamCopy = true;
  const baseline = probes[0];
  if (!baseline) throw new RecordingAssemblyError("probe_failed");
  for (const [index, probe] of probes.entries()) {
    const selection = spec.selections[index];
    if (!selection) throw new RecordingAssemblyError("probe_failed");
    if (
      probe.video.width !== selection.resolution.width ||
      probe.video.height !== selection.resolution.height ||
      probe.video.width !== spec.output.width ||
      probe.video.height !== spec.output.height
    ) {
      throw new RecordingAssemblyError("resolution_mismatch", {
        scene_ordinal: selection.scene_ordinal,
      });
    }
    if (
      !exactNumber(probe.video.effective_fps, selection.effective_fps) ||
      !exactNumber(probe.video.effective_fps, spec.output.fps)
    ) {
      throw new RecordingAssemblyError("fps_mismatch", { scene_ordinal: selection.scene_ordinal });
    }
    if (
      probe.video.time_base !== selection.time_base ||
      probe.video.time_base !== baseline.video.time_base
    ) {
      throw new RecordingAssemblyError("time_base_mismatch", {
        scene_ordinal: selection.scene_ordinal,
      });
    }
    if (selection.capture_backend !== spec.selections[0]?.capture_backend) {
      throw new RecordingAssemblyError("capture_backend_mismatch", {
        scene_ordinal: selection.scene_ordinal,
      });
    }
    const audio = audioByRole(probe);
    if (!spec.audio_sources) {
      for (const role of spec.required_tracks) {
        if (!audio.has(role)) {
          throw new RecordingAssemblyError("required_audio_missing", {
            scene_ordinal: selection.scene_ordinal,
            track: role,
          });
        }
      }
    }
    if (
      probe.video.codec !== baseline.video.codec ||
      probe.video.profile !== baseline.video.profile ||
      probe.video.pixel_format !== baseline.video.pixel_format ||
      probe.video.color_metadata !== baseline.video.color_metadata
    ) {
      streamCopy = false;
    }
    if (!spec.audio_sources) {
      const baselineAudio = audioByRole(baseline);
      for (const role of [...spec.required_tracks, ...spec.optional_tracks]) {
        const current = audio.get(role);
        const first = baselineAudio.get(role);
        if (!current || !first) {
          streamCopy = false;
          continue;
        }
        if (
          current.codec !== first.codec ||
          current.sample_rate !== first.sample_rate ||
          current.channel_layout !== first.channel_layout
        ) {
          streamCopy = false;
        }
      }
    }
  }
  return streamCopy ? "stream_copy" : "normalize";
}

export function segmentOffsetMap(
  selections: SegmentSelection[],
  probes: SegmentStreamProbe[],
): SegmentOffset[] {
  let offsetUs = 0;
  let frameOffset = 0;
  return selections.map((selection, index) => {
    const probe = probes[index];
    if (!probe || !finitePositive(probe.duration_us)) {
      throw new RecordingAssemblyError("probe_failed", { scene_ordinal: selection.scene_ordinal });
    }
    const offset: SegmentOffset = {
      scene_id: selection.scene_id,
      attempt_id: selection.attempt_id,
      offset_us: offsetUs,
      duration_us: Math.round(probe.duration_us),
      frame_offset: frameOffset,
      source_frame_start: selection.source_frame_range?.start ?? 0,
      source_pts_start_us: selection.source_pts_range_us?.start ?? 0,
    };
    offsetUs += offset.duration_us;
    frameOffset += Math.round((offset.duration_us * selection.effective_fps) / 1_000_000);
    return offset;
  });
}

function offsetLandmark<T extends { frame_index: number; pts_us: number }>(
  value: T,
  offset: SegmentOffset,
): T {
  return {
    ...value,
    frame_index: value.frame_index - offset.source_frame_start + offset.frame_offset,
    pts_us: value.pts_us - offset.source_pts_start_us + offset.offset_us,
  };
}

export function rebaseActionEvents(
  actionsByAttempt: Record<string, ActionTimelineEvent[]>,
  offsets: SegmentOffset[],
): ActionTimelineEvent[] {
  const output: ActionTimelineEvent[] = [];
  for (const offset of offsets) {
    for (const event of actionsByAttempt[offset.attempt_id] ?? []) {
      const rebased: ActionTimelineEvent = {
        ...event,
        t_start_ms:
          event.t_start_ms - offset.source_pts_start_us / 1_000 + offset.offset_us / 1_000,
        t_action_ms:
          event.t_action_ms - offset.source_pts_start_us / 1_000 + offset.offset_us / 1_000,
        t_end_ms: event.t_end_ms - offset.source_pts_start_us / 1_000 + offset.offset_us / 1_000,
        cursor_path: event.cursor_path
          ? {
              ...event.cursor_path,
              samples: event.cursor_path.samples.map((sample) => offsetLandmark(sample, offset)),
              arrival: offsetLandmark(event.cursor_path.arrival, offset),
            }
          : undefined,
        input_landmarks: event.input_landmarks
          ? Object.fromEntries(
              Object.entries(event.input_landmarks).map(([key, value]) => [
                key,
                value ? offsetLandmark(value, offset) : value,
              ]),
            )
          : undefined,
        presentation: event.presentation
          ? {
              ...event.presentation,
              first_post_input_frame: event.presentation.first_post_input_frame
                ? offsetLandmark(event.presentation.first_post_input_frame, offset)
                : undefined,
              first_post_input_paint: event.presentation.first_post_input_paint
                ? offsetLandmark(event.presentation.first_post_input_paint, offset)
                : undefined,
            }
          : undefined,
      };
      assertActionPts(rebased);
      output.push(rebased);
    }
  }
  return output.sort(
    (left, right) => left.t_start_ms - right.t_start_ms || left.ordinal - right.ordinal,
  );
}

function assertActionPts(event: ActionTimelineEvent): void {
  const pts: number[] = [];
  if (event.cursor_path) pts.push(...event.cursor_path.samples.map((sample) => sample.pts_us));
  if (event.input_landmarks) {
    pts.push(
      ...Object.values(event.input_landmarks).flatMap((value) => (value ? [value.pts_us] : [])),
    );
  }
  if (event.presentation?.first_post_input_frame) {
    pts.push(event.presentation.first_post_input_frame.pts_us);
  }
  if (event.presentation?.first_post_input_paint) {
    pts.push(event.presentation.first_post_input_paint.pts_us);
  }
  if (pts.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RecordingAssemblyError("sidecar_pts_invalid", { ordinal: event.ordinal });
  }
}

export function rebaseStepCheckpoints(
  checkpointsByAttempt: Record<string, StepCheckpoint[]>,
  offsets: SegmentOffset[],
): StepCheckpoint[] {
  const output: StepCheckpoint[] = [];
  for (const offset of offsets) {
    for (const checkpoint of checkpointsByAttempt[offset.attempt_id] ?? []) {
      const frameRange = {
        start: checkpoint.frame_range.start - offset.source_frame_start + offset.frame_offset,
        end: checkpoint.frame_range.end - offset.source_frame_start + offset.frame_offset,
      };
      const ptsRange = {
        start: checkpoint.pts_range_us.start - offset.source_pts_start_us + offset.offset_us,
        end: checkpoint.pts_range_us.end - offset.source_pts_start_us + offset.offset_us,
      };
      if (frameRange.end < frameRange.start || ptsRange.end < ptsRange.start) {
        throw new RecordingAssemblyError("sidecar_pts_invalid", {
          scene_ordinal: checkpoint.scene_ordinal,
        });
      }
      output.push({ ...checkpoint, frame_range: frameRange, pts_range_us: ptsRange });
    }
  }
  return output.sort(
    (left, right) =>
      left.pts_range_us.start - right.pts_range_us.start || left.step_ordinal - right.step_ordinal,
  );
}

function resolveContained(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new RecordingAssemblyError("input_path_invalid");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new RecordingAssemblyError("input_path_invalid");
  }
  return resolved;
}

export async function recordingAssemblyInputSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function prepareLiveRepairAssembly(
  options: PrepareLiveRepairAssemblyOptions,
): Promise<PreparedLiveRepairAssembly | null> {
  if (!options.snapshot.attempts.some((attempt) => attempt.status === "failed")) return null;
  const selectedByScene = new Map<string, (typeof options.snapshot.attempts)[number]>();
  for (const attempt of options.snapshot.attempts) {
    if (attempt.status === "committed") selectedByScene.set(attempt.scene_id, attempt);
  }
  const attempts = [...selectedByScene.values()].sort(
    (left, right) => left.scene_ordinal - right.scene_ordinal,
  );
  if (
    attempts.length === 0 ||
    attempts.some(
      (attempt, index) =>
        attempt.scene_ordinal !== index + 1 ||
        !attempt.source_frame_range ||
        !attempt.source_pts_range_us,
    )
  ) {
    throw new RecordingAssemblyError("scene_selection_invalid");
  }
  const hashFile = options.hashFile ?? recordingAssemblyInputSha256;
  const probe = options.probe ?? probeSegmentWithFfmpeg;
  const selections: SegmentSelection[] = [];
  for (const attempt of attempts) {
    if (!attempt.source_frame_range || !attempt.source_pts_range_us) {
      throw new RecordingAssemblyError("scene_selection_invalid", {
        scene_ordinal: attempt.scene_ordinal,
      });
    }
    const mediaPath = resolveContained(options.takeRoot, attempt.media_path);
    const [mediaSha256, stream] = await Promise.all([
      hashFile(mediaPath).catch((error) => {
        throw new RecordingAssemblyError(
          "input_hash_mismatch",
          { attempt_id: attempt.attempt_id },
          error,
        );
      }),
      probe(mediaPath).catch((error) => {
        throw new RecordingAssemblyError("probe_failed", { attempt_id: attempt.attempt_id }, error);
      }),
    ]);
    selections.push({
      scene_id: attempt.scene_id,
      scene_ordinal: attempt.scene_ordinal,
      attempt_id: attempt.attempt_id,
      media_path: attempt.media_path,
      media_sha256: mediaSha256,
      resolution: { width: stream.video.width, height: stream.video.height },
      effective_fps: stream.video.effective_fps,
      time_base: stream.video.time_base,
      capture_backend: options.captureBackend,
      source_frame_range: attempt.source_frame_range,
      source_pts_range_us: attempt.source_pts_range_us,
    });
  }
  const audioSources = options.audioSources ?? [];
  const spec: RecordingAssemblySpec = {
    policy_version: 1,
    source_take_id: options.sourceTakeId,
    selections,
    output: options.output,
    required_tracks: audioSources
      .filter((source) => source.requirement === "required")
      .map((source) => source.role),
    optional_tracks: audioSources
      .filter((source) => source.requirement === "optional")
      .map((source) => source.role),
    ...(audioSources.length > 0 ? { audio_sources: audioSources } : {}),
    toolchain: options.toolchain,
  };
  validateRecordingAssemblySpec(spec);
  const selectedAttempts = new Set(selections.map((selection) => selection.attempt_id));
  return {
    spec,
    actionsByAttempt: Object.fromEntries(
      Object.entries(options.snapshot.actions_by_attempt).filter(([attemptId]) =>
        selectedAttempts.has(attemptId),
      ),
    ),
    checkpointsByAttempt: Object.fromEntries(
      Object.entries(options.snapshot.checkpoints_by_attempt).filter(([attemptId]) =>
        selectedAttempts.has(attemptId),
      ),
    ),
  };
}

function runProcess(command: string, args: string[], collectStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256_000) stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || collectStderr) resolve(stderr);
      else reject(new Error(`process_exit_${code ?? "signal"}`));
    });
  });
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : 0;
}

export async function probeSegmentWithFfmpeg(mediaPath: string): Promise<SegmentStreamProbe> {
  if (!ffmpegPath) throw new RecordingAssemblyError("ffmpeg_unavailable");
  const stderr = await runProcess(ffmpegPath, ["-hide_banner", "-i", mediaPath], true).catch(
    (error) => {
      throw new RecordingAssemblyError("probe_failed", {}, error);
    },
  );
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video =
    /Video:\s*([^,]+)(?:\s*\(([^)]+)\))?,\s*([^,]+),[^\n]*?(\d+)x(\d+)[^\n]*?(\d+(?:\.\d+)?)\s*fps[^\n]*?(\d+(?:\.\d+)?)k?\s*tbn/i.exec(
      stderr,
    );
  if (!duration || !video) throw new RecordingAssemblyError("probe_failed");
  const durationUs =
    (Number(duration[1]) * 3_600 + Number(duration[2]) * 60 + Number(duration[3])) * 1_000_000;
  const audio = [...stderr.matchAll(/Audio:\s*([^,]+),\s*(\d+)\s*Hz,\s*([^,\n]+)/gi)].map(
    (match, index) => ({
      role: index === 0 ? "microphone" : `track_${index + 1}`,
      codec: match[1]?.trim() ?? "unknown",
      sample_rate: Number(match[2]),
      channel_layout: match[3]?.trim() ?? "unknown",
    }),
  );
  return {
    duration_us: Math.round(durationUs),
    video: {
      codec: video[1]?.trim() ?? "unknown",
      profile: video[2]?.trim() ?? "unknown",
      pixel_format: video[3]?.trim() ?? "unknown",
      color_metadata: "unspecified",
      width: Number(video[4]),
      height: Number(video[5]),
      effective_fps: parseRate(video[6]),
      time_base: `1/${Math.round(parseRate(video[7]))}`,
    },
    audio,
  };
}

export function buildSegmentFfmpegArgs(
  inputListPath: string,
  outputPath: string,
  spec: RecordingAssemblySpec,
  assemblyPath: RecordingAssemblyPath,
): string[] {
  const shared = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    inputListPath,
  ];
  if (assemblyPath === "stream_copy") {
    return [...shared, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-y", outputPath];
  }
  return [
    ...shared,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-pix_fmt",
    spec.output.pixel_format,
    "-r",
    String(spec.output.fps),
    "-c:a",
    spec.output.audio_codec,
    "-ar",
    String(spec.output.audio_sample_rate),
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
}

function seconds(microseconds: number): string {
  return Math.max(0, microseconds / 1_000_000).toFixed(6);
}

export function buildSegmentAudioFfmpegArgs(
  inputPath: string | null,
  outputPath: string,
  source: RecordingAssemblyAudioSource,
  offsets: SegmentOffset[],
  output: RecordingOutputSettings,
): string[] {
  const totalDurationUs = offsets.reduce((total, offset) => total + offset.duration_us, 0);
  if (!inputPath) {
    return [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${output.audio_sample_rate}:cl=${output.audio_channel_layout}`,
      "-t",
      seconds(totalDurationUs),
      "-c:a",
      output.audio_codec,
      outputPath,
    ];
  }
  const filters: string[] = [
    `[0:a]adelay=delays=${Math.round(source.first_pts_us / 1_000)}:all=1,apad[aligned]`,
  ];
  const inputs: string[] = [];
  if (offsets.length === 1) {
    inputs.push("[aligned]");
  } else {
    const splitOutputs = offsets.map((_, index) => `[split${index}]`).join("");
    filters.push(`[aligned]asplit=${offsets.length}${splitOutputs}`);
    inputs.push(...offsets.map((_, index) => `[split${index}]`));
  }
  offsets.forEach((offset, index) => {
    filters.push(
      `${inputs[index]}atrim=start=${seconds(offset.source_pts_start_us)}:duration=${seconds(offset.duration_us)},asetpts=PTS-STARTPTS[scene${index}]`,
    );
  });
  filters.push(
    `${offsets.map((_, index) => `[scene${index}]`).join("")}concat=n=${offsets.length}:v=0:a=1[out]`,
  );
  return [
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-c:a",
    output.audio_codec,
    "-ar",
    String(output.audio_sample_rate),
    "-t",
    seconds(totalDurationUs),
    outputPath,
  ];
}

export function buildRevisionMuxArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  durationUs: number,
): string[] {
  return [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-t",
    seconds(durationUs),
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

async function writeJsonDurable(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial`;
  const handle = await fs.open(temporary, "w");
  try {
    await handle.writeFile(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  const directory = await fs.open(path.dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function nextRevisionId(takeRoot: string, digest: string): Promise<string> {
  const revisionsRoot = path.join(takeRoot, "revisions");
  const entries = await fs.readdir(revisionsRoot, { withFileTypes: true }).catch(() => []);
  let highest = 0;
  for (const entry of entries) {
    const match = /^rev-(\d{6})-/.exec(entry.name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `rev-${String(highest + 1).padStart(6, "0")}-${digest.slice(0, 12)}`;
}

async function existingRevisionByDigest(
  takeRoot: string,
  digest: string,
): Promise<RecordingRevision | null> {
  const revisionsRoot = path.join(takeRoot, "revisions");
  const entries = await fs.readdir(revisionsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(digest.slice(0, 12))) continue;
    const manifest = await fs
      .readFile(path.join(revisionsRoot, entry.name, "revision.json"), "utf8")
      .then((value) => JSON.parse(value) as RecordingRevision)
      .catch(() => null);
    if (manifest?.assembly_sha256 === digest) {
      return {
        ...manifest,
        audio_paths: manifest.audio_paths ?? {},
        compatibility_audio_path: manifest.compatibility_audio_path ?? null,
      };
    }
  }
  return null;
}

function concatList(paths: string[]): string {
  return paths
    .map((value) => `file '${value.replaceAll("'", "'\\''")}'`)
    .join("\n")
    .concat("\n");
}

async function assembleRecordingSegmentsInternal(
  options: AssembleRecordingSegmentsOptions,
): Promise<RecordingRevision> {
  validateRecordingAssemblySpec(options.spec);
  const digest = recordingAssemblyDigest(options.spec);
  const existing = await existingRevisionByDigest(options.takeRoot, digest);
  if (existing) return existing;
  const hashFile = options.hashFile ?? recordingAssemblyInputSha256;
  const probe = options.probe ?? probeSegmentWithFfmpeg;
  const mediaPaths: string[] = [];
  for (const selection of options.spec.selections) {
    const mediaPath = resolveContained(options.takeRoot, selection.media_path);
    const actualHash = await hashFile(mediaPath).catch((error) => {
      throw new RecordingAssemblyError(
        "input_hash_mismatch",
        { attempt_id: selection.attempt_id },
        error,
      );
    });
    if (actualHash !== selection.media_sha256) {
      throw new RecordingAssemblyError("input_hash_mismatch", { attempt_id: selection.attempt_id });
    }
    mediaPaths.push(mediaPath);
  }
  const audioSourcePaths = new Map<string, string>();
  for (const source of options.spec.audio_sources ?? []) {
    if (!source.media_path || !source.media_sha256) continue;
    const mediaPath = resolveContained(options.takeRoot, source.media_path);
    const actualHash = await hashFile(mediaPath).catch((error) => {
      throw new RecordingAssemblyError("input_hash_mismatch", { track: source.role }, error);
    });
    if (actualHash !== source.media_sha256) {
      throw new RecordingAssemblyError("input_hash_mismatch", { track: source.role });
    }
    audioSourcePaths.set(source.role, mediaPath);
  }
  await options.failureInjector?.("inputs_validated");
  const probes = await Promise.all(mediaPaths.map((mediaPath) => probe(mediaPath)));
  const assemblyPath = classifySegmentCompatibility(options.spec, probes);
  const offsets = segmentOffsetMap(options.spec.selections, probes);
  await options.failureInjector?.("probed");
  const revisionId = await nextRevisionId(options.takeRoot, digest);
  const revisionsRoot = path.join(options.takeRoot, "revisions");
  const stagingRoot = path.join(revisionsRoot, `.${revisionId}.staging.${process.pid}`);
  const finalRoot = path.join(revisionsRoot, revisionId);
  const outputPath = path.join(stagingRoot, "media", "video.mp4");
  const videoOnlyPath = options.spec.audio_sources?.length
    ? path.join(stagingRoot, "media", "video-only.mp4")
    : outputPath;
  const inputListPath = path.join(stagingRoot, "inputs.ffconcat");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(inputListPath, concatList(mediaPaths), "utf8");
  const args = buildSegmentFfmpegArgs(inputListPath, videoOnlyPath, options.spec, assemblyPath);
  await options.failureInjector?.("ffmpeg_start");
  try {
    if (options.runFfmpeg) await options.runFfmpeg(args);
    else {
      if (!ffmpegPath) throw new RecordingAssemblyError("ffmpeg_unavailable");
      await runProcess(ffmpegPath, args);
    }
  } catch (error) {
    if (error instanceof RecordingAssemblyError) throw error;
    throw new RecordingAssemblyError("ffmpeg_failed", {}, error);
  }
  await options.failureInjector?.("ffmpeg_complete");
  const audioPaths: Record<string, string> = {};
  let compatibilityAudioRelative: string | null = null;
  if (options.spec.audio_sources?.length) {
    const totalDurationUs = offsets.reduce((total, offset) => total + offset.duration_us, 0);
    const audioRoot = path.join(stagingRoot, "audio");
    await fs.mkdir(audioRoot, { recursive: true });
    const compatibilityStems: Array<{ path: string; firstPtsUs: number }> = [];
    for (const source of options.spec.audio_sources) {
      const relativePath = `audio/${source.role}.m4a`;
      const stemPath = path.join(stagingRoot, relativePath);
      const audioArgs = buildSegmentAudioFfmpegArgs(
        audioSourcePaths.get(source.role) ?? null,
        stemPath,
        source,
        offsets,
        options.spec.output,
      );
      try {
        if (options.runFfmpeg) await options.runFfmpeg(audioArgs);
        else {
          if (!ffmpegPath) throw new RecordingAssemblyError("ffmpeg_unavailable");
          await runProcess(ffmpegPath, audioArgs);
        }
      } catch (error) {
        if (error instanceof RecordingAssemblyError) throw error;
        throw new RecordingAssemblyError("ffmpeg_failed", { track: source.role }, error);
      }
      audioPaths[source.role] = `revisions/${revisionId}/${relativePath}`;
      compatibilityStems.push({ path: stemPath, firstPtsUs: 0 });
    }
    compatibilityAudioRelative = "audio/compatibility.m4a";
    const compatibilityAudioPath = path.join(stagingRoot, compatibilityAudioRelative);
    const mixArgs = recordingCompatibilityMixArgs({
      stems: compatibilityStems,
      outputPath: compatibilityAudioPath,
      videoDurationUs: totalDurationUs,
    });
    const muxArgs = buildRevisionMuxArgs(
      videoOnlyPath,
      compatibilityAudioPath,
      outputPath,
      totalDurationUs,
    );
    try {
      if (options.runFfmpeg) {
        await options.runFfmpeg(mixArgs);
        await options.runFfmpeg(muxArgs);
      } else {
        if (!ffmpegPath) throw new RecordingAssemblyError("ffmpeg_unavailable");
        await runProcess(ffmpegPath, mixArgs);
        await runProcess(ffmpegPath, muxArgs);
      }
    } catch (error) {
      if (error instanceof RecordingAssemblyError) throw error;
      throw new RecordingAssemblyError("ffmpeg_failed", {}, error);
    }
    await options.failureInjector?.("audio_assembled");
  }
  const rebasedActions = options.actionsByAttempt
    ? rebaseActionEvents(options.actionsByAttempt, offsets)
    : null;
  const rebasedCheckpoints = options.checkpointsByAttempt
    ? rebaseStepCheckpoints(options.checkpointsByAttempt, offsets)
    : null;
  const actionsRelative = rebasedActions ? "sidecars/actions.v3.json" : null;
  const checkpointsRelative = rebasedCheckpoints ? "sidecars/checkpoints.v1.json" : null;
  if (actionsRelative)
    await writeJsonDurable(path.join(stagingRoot, actionsRelative), rebasedActions);
  if (checkpointsRelative) {
    await writeJsonDurable(path.join(stagingRoot, checkpointsRelative), rebasedCheckpoints);
  }
  await options.failureInjector?.("sidecars_rebased");
  const outputProbe = await probe(outputPath).catch((error) => {
    throw new RecordingAssemblyError("output_validation_failed", {}, error);
  });
  if (
    outputProbe.video.width !== options.spec.output.width ||
    outputProbe.video.height !== options.spec.output.height ||
    !exactNumber(outputProbe.video.effective_fps, options.spec.output.fps)
  ) {
    throw new RecordingAssemblyError("output_validation_failed");
  }
  await fs.rm(inputListPath, { force: true });
  if (videoOnlyPath !== outputPath) await fs.rm(videoOnlyPath, { force: true });
  await options.failureInjector?.("output_validated");
  const revision: RecordingRevision = {
    policy_version: 1,
    revision_id: revisionId,
    assembly_sha256: digest,
    output_path: `revisions/${revisionId}/media/video.mp4`,
    selected_attempts: options.spec.selections,
    assembly_path: assemblyPath,
    offset_map: offsets,
    actions_path: actionsRelative ? `revisions/${revisionId}/${actionsRelative}` : null,
    checkpoints_path: checkpointsRelative ? `revisions/${revisionId}/${checkpointsRelative}` : null,
    audio_paths: audioPaths,
    compatibility_audio_path: compatibilityAudioRelative
      ? `revisions/${revisionId}/${compatibilityAudioRelative}`
      : null,
  };
  await writeJsonDurable(path.join(stagingRoot, "assembly.json"), options.spec);
  await writeJsonDurable(path.join(stagingRoot, "revision.json"), revision);
  await options.failureInjector?.("before_commit");
  try {
    await fs.mkdir(revisionsRoot, { recursive: true });
    await fs.rename(stagingRoot, finalRoot);
    await writeJsonDurable(path.join(revisionsRoot, "current.json"), revision);
  } catch (error) {
    throw new RecordingAssemblyError("revision_commit_failed", {}, error);
  }
  return revision;
}

export async function assembleRecordingSegments(
  options: AssembleRecordingSegmentsOptions,
): Promise<RecordingRevision> {
  const startedAt = Date.now();
  await recordEngineLog({
    event: "recording.stitch.started",
    context: {
      take_id: options.spec.source_take_id,
      phase: "stitch",
    },
    details: {
      scene_count: options.spec.selections.length,
      selected_attempts: options.spec.selections.map((selection) => ({
        scene_id: selection.scene_id,
        attempt_id: selection.attempt_id,
      })),
    },
  });
  try {
    const revision = await assembleRecordingSegmentsInternal(options);
    await recordEngineLog({
      event: "recording.stitch.completed",
      context: {
        take_id: options.spec.source_take_id,
        phase: "stitch",
        duration_ms: Math.max(0, Date.now() - startedAt),
        artifact_relpath: revision.output_path,
      },
      details: {
        revision_id: revision.revision_id,
        assembly_path: revision.assembly_path,
        selected_attempt_count: revision.selected_attempts.length,
      },
    });
    return revision;
  } catch (error) {
    await recordEngineLog({
      level: "error",
      event: "recording.stitch.failed",
      context: {
        take_id: options.spec.source_take_id,
        phase: "stitch",
        duration_ms: Math.max(0, Date.now() - startedAt),
        reason_code: error instanceof RecordingAssemblyError ? error.reason : "unexpected_error",
      },
      error,
    });
    throw error;
  }
}

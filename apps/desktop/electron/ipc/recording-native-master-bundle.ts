import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingDimensionsV2 } from "@storycapture/shared-types/recording-v2";
import type {
  RecordingBundleV3,
  RecordingQualityEvidenceV3,
  RecordingResultV3,
  RecordingV3FailureCode,
} from "@storycapture/shared-types/recording-v3";

import { type RecordingBundleWorkspace, recordingBundleArtifact } from "./recording-bundle";
import { verifyRecordingCadenceV3 } from "./recording-cadence-verifier";

export interface RecordingNativeMasterEvidence {
  artifact_path: string;
  artifact_bytes: number;
  source_updates: number;
  output_frames: number;
  held_frames: number;
  encoder_dropped_frames: number;
  backpressure_events: number;
  unresolved_backpressure_events: number;
  width: number;
  height: number;
  started_monotonic_us: number;
  ended_monotonic_us: number;
  finalized_duration_us: number;
  pts_gaps: number;
  pts_duplicates: number;
  pts_non_monotonic: number;
  encoder: { id: string; hardware_accelerated: true };
  codec: "h264";
  pixel_format: "nv12" | "yuv420p";
  finalized: boolean;
  artifact: {
    finalized: boolean;
    full_decode_succeeded: boolean;
    decoded_frames: number;
  };
  failure_codes?: readonly RecordingV3FailureCode[];
}

export interface FinalizeRecordingNativeMasterInput {
  workspace: RecordingBundleWorkspace;
  evidence: RecordingNativeMasterEvidence;
  dimensions: RecordingDimensionsV2;
  backend: { id: string; version: string };
  quality: RecordingQualityEvidenceV3;
  actionsSourcePath?: string | null;
  audioSources?: ReadonlyArray<{
    role: "microphone" | "system";
    sourcePath: string;
  }>;
}

function pushUnique<T>(target: T[], values: readonly T[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await fs.copyFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const copied = await fs.stat(destination);
  if (!copied.isFile() || copied.size === 0) {
    await fs.rm(destination, { force: true });
    return false;
  }
  return true;
}

export async function finalizeRecordingNativeMaster(
  input: FinalizeRecordingNativeMasterInput,
): Promise<RecordingResultV3> {
  const expectedArtifactPath = input.workspace.resolve("master/video.mp4");
  if (path.resolve(input.evidence.artifact_path) !== path.resolve(expectedArtifactPath)) {
    throw new Error("native recording artifact path does not match its bundle workspace");
  }
  const artifact = await recordingBundleArtifact(input.workspace.stagingPath, "master/video.mp4");
  const failures: RecordingV3FailureCode[] = [];
  pushUnique(failures, input.evidence.failure_codes ?? []);
  if (artifact.bytes !== input.evidence.artifact_bytes) failures.push("artifact_truncated");
  if (!input.evidence.finalized || !input.evidence.artifact.finalized) {
    failures.push("artifact_finalize_failed");
  }
  if (!input.evidence.artifact.full_decode_succeeded) failures.push("artifact_decode_failed");
  if (input.evidence.artifact.decoded_frames !== input.evidence.output_frames) {
    failures.push("artifact_frame_count_mismatch");
  }
  if (
    input.evidence.width !== input.dimensions.requested_output_width ||
    input.evidence.height !== input.dimensions.requested_output_height
  ) {
    failures.push("artifact_resolution_mismatch");
  }
  const cadence = verifyRecordingCadenceV3({
    version: 3,
    requested_fps: { numerator: 60, denominator: 1 },
    active_duration_us: input.evidence.finalized_duration_us,
    source_updates: input.evidence.source_updates,
    output_frames: input.evidence.output_frames,
    held_frames: input.evidence.held_frames,
    encoder_dropped_frames: input.evidence.encoder_dropped_frames,
    backpressure_events: input.evidence.backpressure_events,
    unresolved_backpressure_events: input.evidence.unresolved_backpressure_events,
    pts_gaps: input.evidence.pts_gaps,
    pts_duplicates: input.evidence.pts_duplicates,
    pts_non_monotonic: input.evidence.pts_non_monotonic,
    initial_surface_received: input.evidence.source_updates > 0,
  });
  pushUnique(failures, cadence.failure_codes);
  pushUnique(failures, input.quality.failure_codes);

  const actionsCopied = input.actionsSourcePath
    ? await copyIfPresent(input.actionsSourcePath, input.workspace.resolve("sidecars/actions.json"))
    : false;
  const audio: RecordingBundleV3["audio"] = [];
  for (const source of input.audioSources ?? []) {
    const relativePath = `audio/${source.role}.wav` as const;
    if (!(await copyIfPresent(source.sourcePath, input.workspace.resolve(relativePath)))) continue;
    audio.push({
      ...(await recordingBundleArtifact(input.workspace.stagingPath, relativePath)),
      role: source.role,
      codec: "pcm_s16le",
    });
  }
  await input.workspace.writeJson("evidence/cadence.json", cadence);
  await input.workspace.writeJson("evidence/quality.json", input.quality);
  await fs.writeFile(
    input.workspace.resolve("evidence/sequence-ledger.jsonl"),
    `${JSON.stringify({
      version: 3,
      source_updates: cadence.source_updates,
      output_frames: cadence.output_frames,
      held_frames: cadence.held_frames,
      started_monotonic_us: input.evidence.started_monotonic_us,
      ended_monotonic_us: input.evidence.ended_monotonic_us,
    })}\n`,
    "utf8",
  );
  const completed = failures.length === 0;
  const manifest: RecordingBundleV3 = {
    schema_version: 3,
    status: completed ? "completed" : "quality_failed",
    created_at: new Date().toISOString(),
    delivery_policy: "strict",
    capture_contract: {
      requested_fps: { numerator: 60, denominator: 1 },
      verified_fps: { numerator: 60, denominator: 1 },
      dimensions: input.dimensions,
    },
    master: {
      ...artifact,
      relative_path: "master/video.mp4",
      codec: "h264",
      pixel_format: input.evidence.pixel_format,
      frame_count: input.evidence.output_frames,
      exact_fps: { numerator: 60, denominator: 1 },
      native_capture_backend: input.backend,
      native_encoder: input.evidence.encoder,
      started_monotonic_us: input.evidence.started_monotonic_us,
      ended_monotonic_us: input.evidence.ended_monotonic_us,
      finalized_duration_us: input.evidence.finalized_duration_us,
    },
    proxy: null,
    audio,
    cadence,
    artifact: input.evidence.artifact,
    quality: input.quality,
    evidence: {
      cadence_path: "evidence/cadence.json",
      quality_path: "evidence/quality.json",
    },
    sidecars: { actions_path: actionsCopied ? "sidecars/actions.json" : null },
    sequence_ledger_path: "evidence/sequence-ledger.jsonl",
    failure_codes: failures,
  };
  const bundlePath = await input.workspace.commit(manifest);
  const masterPath = path.join(bundlePath, "master/video.mp4");
  return completed
    ? {
        version: 3,
        status: "completed",
        delivery_policy: "strict",
        bundle_path: bundlePath,
        output_path: masterPath,
        diagnostic_bundle_path: null,
        duration_ms: Math.round(input.evidence.finalized_duration_us / 1_000),
        bytes: artifact.bytes,
        master_path: masterPath,
        proxy_path: null,
        cadence_evidence: cadence,
        quality_evidence: input.quality,
      }
    : {
        version: 3,
        status: "quality_failed",
        delivery_policy: "strict",
        bundle_path: bundlePath,
        output_path: null,
        diagnostic_bundle_path: bundlePath,
        duration_ms: Math.round(input.evidence.finalized_duration_us / 1_000),
        bytes: artifact.bytes,
        master_path: masterPath,
        proxy_path: null,
        cadence_evidence: cadence,
        quality_evidence: input.quality,
      };
}

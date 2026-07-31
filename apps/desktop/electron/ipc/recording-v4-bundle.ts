import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readRecordingV4Bundle,
  RECORDING_V4_BUNDLE_SCHEMA_VERSION,
  RECORDING_V4_FRAME_RATE,
  RECORDING_V4_PROFILE,
  type RecordingV4Artifact,
  type RecordingV4AudioEvidence,
  type RecordingV4AudioRole,
  type RecordingV4Bundle,
  type RecordingV4CadenceEvidence,
  type RecordingV4EncoderEvidence,
  type RecordingV4FailureCode,
  type RecordingV4QualityEvidence,
  type RecordingV4Result,
  type RecordingV4TargetIdentity,
} from "@storycapture/shared-types/recording-v4";

import { writeJsonAtomic } from "./json-store";
import {
  verifyRecordingV4Audio,
  verifyRecordingV4Cadence,
  verifyRecordingV4Encoder,
  verifyRecordingV4Quality,
} from "./recording-v4-verifier";

export interface RecordingV4NativeFinalEvidence {
  artifact_path: string;
  encoder: RecordingV4EncoderEvidence;
  cadence: RecordingV4CadenceEvidence;
  audio: RecordingV4AudioEvidence[];
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4ArtifactProbe {
  finalized: boolean;
  full_decode_succeeded: boolean;
  decoded_frames: number;
  duration_us: number;
  physical_width: number;
  physical_height: number;
}

export interface RecordingV4AudioArtifactInput {
  role: RecordingV4AudioRole;
  source_path: string;
}

export interface FinalizeRecordingV4Input {
  session_id: string;
  project_path: string;
  workspace_path: string;
  target: RecordingV4TargetIdentity;
  native: RecordingV4NativeFinalEvidence;
  artifact_probe: RecordingV4ArtifactProbe;
  quality: RecordingV4QualityEvidence;
  required_quality_reference_ids: string[];
  requested_audio_roles: RecordingV4AudioRole[];
  audio_artifacts: RecordingV4AudioArtifactInput[];
  actions_path: string | null;
  now?: () => Date;
}

async function sha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function artifact(root: string, relativePath: string): Promise<RecordingV4Artifact> {
  const filePath = path.join(root, relativePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Recording V4 artifact is invalid: ${relativePath}`);
  return { relative_path: relativePath, bytes: stat.size, sha256: await sha256(filePath) };
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resultFromBundle(bundlePath: string, bundle: RecordingV4Bundle): RecordingV4Result {
  const masterPath = path.join(bundlePath, "master/video.mp4");
  return bundle.status === "completed"
    ? {
        version: 4, profile: RECORDING_V4_PROFILE, session_id: bundle.session_id, state: "completed",
        bundle_path: bundlePath, output_path: masterPath, diagnostic_bundle_path: null, failure_codes: [],
      }
    : {
        version: 4, profile: RECORDING_V4_PROFILE, session_id: bundle.session_id, state: "quality_failed",
        bundle_path: bundlePath, output_path: null, diagnostic_bundle_path: bundlePath,
        failure_codes: bundle.failure_codes,
      };
}

export class RecordingV4BundleFinalizer {
  private readonly operations = new Map<string, Promise<RecordingV4Result>>();

  finalize(input: FinalizeRecordingV4Input): Promise<RecordingV4Result> {
    const existing = this.operations.get(input.session_id);
    if (existing) return existing;
    const operation = this.finalizeOnce(input);
    this.operations.set(input.session_id, operation);
    return operation;
  }

  private async finalizeOnce(input: FinalizeRecordingV4Input): Promise<RecordingV4Result> {
    const exportsDir = path.join(input.project_path, "exports");
    const workspace = path.resolve(input.workspace_path);
    const finalPath = path.join(exportsDir, `recording-${input.session_id}.sc-recording`);
    if (!contained(exportsDir, workspace) || !contained(exportsDir, finalPath)) {
      throw new Error("Recording V4 workspace escaped the project exports directory.");
    }
    try {
      const previous = readRecordingV4Bundle(JSON.parse(await fs.readFile(path.join(finalPath, "manifest.json"), "utf8")));
      if (previous?.session_id === input.session_id) return resultFromBundle(finalPath, previous);
      throw new Error("Recording V4 final path already exists with incompatible contents.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await Promise.all(["master", "audio", "evidence", "sidecars"].map((name) =>
      fs.mkdir(path.join(workspace, name), { recursive: true })));
    const expectedMaster = path.join(workspace, "master/video.mp4");
    if (path.resolve(input.native.artifact_path) !== expectedMaster) {
      throw new Error("Recording V4 native artifact is outside its authoritative workspace.");
    }
    const master = await artifact(workspace, "master/video.mp4");
    const audio = [] as RecordingV4Bundle["audio"];
    for (const audioInput of input.audio_artifacts) {
      const relativePath = `audio/${audioInput.role}.m4a`;
      const destination = path.join(workspace, relativePath);
      if (path.resolve(audioInput.source_path) !== destination) {
        await fs.copyFile(audioInput.source_path, destination);
      }
      const evidence = input.native.audio.find((entry) => entry.role === audioInput.role);
      if (!evidence) throw new Error(`Recording V4 audio evidence is missing for ${audioInput.role}.`);
      audio.push({ ...(await artifact(workspace, relativePath)), role: audioInput.role, evidence });
    }

    const failures = [...new Set<RecordingV4FailureCode>([
      ...input.native.failure_codes,
      ...verifyRecordingV4Cadence(input.native.cadence),
      ...verifyRecordingV4Encoder(input.native.encoder),
      ...verifyRecordingV4Audio(input.requested_audio_roles, input.native.audio, input.native.cadence.active_duration_us),
      ...verifyRecordingV4Quality(input.quality, input.required_quality_reference_ids),
    ])];
    if (!input.artifact_probe.finalized) failures.push("artifact_finalize_failed");
    if (!input.artifact_probe.full_decode_succeeded) failures.push("artifact_decode_failed");
    if (input.artifact_probe.decoded_frames !== input.native.cadence.output_frames) failures.push("output_frame_count_mismatch");
    if (input.artifact_probe.physical_width !== 1920 || input.artifact_probe.physical_height !== 1080) {
      failures.push("surface_not_1080p");
    }
    const uniqueFailures = [...new Set(failures)];

    await Promise.all([
      writeJsonAtomic(path.join(workspace, "evidence/cadence.json"), input.native.cadence),
      writeJsonAtomic(path.join(workspace, "evidence/quality.json"), input.quality),
      writeJsonAtomic(path.join(workspace, "evidence/bitrate.json"), input.native.encoder),
      fs.writeFile(path.join(workspace, "evidence/frame-ledger.jsonl"),
        `${input.native.cadence.ledger.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8"),
      input.native.audio.length > 0
        ? fs.writeFile(path.join(workspace, "evidence/audio-ledger.jsonl"),
            `${input.native.audio.flatMap((entry) => entry.ledger.map((ledger) =>
              JSON.stringify({ role: entry.role, ...ledger }))).join("\n")}\n`, "utf8")
        : Promise.resolve(),
    ]);
    if (input.actions_path && path.resolve(input.actions_path) !== path.join(workspace, "sidecars/actions.json")) {
      await fs.copyFile(input.actions_path, path.join(workspace, "sidecars/actions.json"));
    }
    const completed = uniqueFailures.length === 0;
    const bundle: RecordingV4Bundle = {
      schema_version: RECORDING_V4_BUNDLE_SCHEMA_VERSION,
      profile: RECORDING_V4_PROFILE,
      status: completed ? "completed" : "quality_failed",
      session_id: input.session_id,
      created_at: (input.now ?? (() => new Date()))().toISOString(),
      target: input.target,
      dimensions: { physical_width: 1920, physical_height: 1080 },
      master: { ...master, relative_path: "master/video.mp4", codec: "h264", pixel_format: "yuv420p",
        frame_rate: RECORDING_V4_FRAME_RATE, frame_count: input.native.cadence.output_frames,
        encoder: input.native.encoder },
      audio,
      cadence: input.native.cadence,
      quality: input.quality,
      artifact: {
        finalized: input.artifact_probe.finalized,
        full_decode_succeeded: input.artifact_probe.full_decode_succeeded,
        decoded_frames: input.artifact_probe.decoded_frames,
        duration_us: input.artifact_probe.duration_us,
      },
      evidence: {
        cadence_path: "evidence/cadence.json", quality_path: "evidence/quality.json",
        bitrate_path: "evidence/bitrate.json", frame_ledger_path: "evidence/frame-ledger.jsonl",
        audio_ledger_path: input.native.audio.length ? "evidence/audio-ledger.jsonl" : null,
      },
      sidecars: { actions_path: input.actions_path ? "sidecars/actions.json" : null },
      failure_codes: uniqueFailures,
    };
    if (!readRecordingV4Bundle(bundle)) throw new Error("Recording V4 final manifest failed validation.");
    await writeJsonAtomic(path.join(workspace, "manifest.json"), bundle);
    await fs.rename(workspace, finalPath);
    return resultFromBundle(finalPath, bundle);
  }
}

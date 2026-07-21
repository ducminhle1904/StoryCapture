import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  RecordingFailureCodeV3,
  RecordingMeasurementScopeV3,
  RecordingQualityEvidenceV3,
} from "@storycapture/shared-types/recording-v2";

import { sha256File } from "./recording-bundle";
import { canonicalizeRecordingCertificationJson } from "./recording-v3-certification-canonical-json";

export interface RecordingV3EvidenceBinding {
  role: string;
  file_name: string;
  measurement_scope: RecordingMeasurementScopeV3;
  byte_length: number;
  sha256: string;
}

export interface RecordingV3CertificationEvidenceArtifact {
  schema_version: 1;
  measurement_scope: "certification_fixture";
  fixture_id: string;
  fixture_version: string;
  generated_at: string;
  inputs: RecordingV3EvidenceBinding[];
  outputs: RecordingV3EvidenceBinding[];
  quality_evidence: RecordingQualityEvidenceV3;
}

export interface CanonicalRecordingV3CertificationEvidenceArtifact {
  artifact: RecordingV3CertificationEvidenceArtifact;
  canonical_json: string;
  sha256: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeEvidenceName(value: string): void {
  if (/(private|secret|signing)[-_ ]?key/i.test(value)) {
    throw new Error("Private signing-key material cannot be bound to certification evidence.");
  }
}

export function bindRecordingV3EvidenceBuffer(input: {
  role: string;
  file_name: string;
  measurement_scope: RecordingMeasurementScopeV3;
  value: Buffer;
}): RecordingV3EvidenceBinding {
  assertSafeEvidenceName(input.role);
  assertSafeEvidenceName(input.file_name);
  if (path.basename(input.file_name) !== input.file_name) {
    throw new Error("Evidence bindings use artifact-local file names, not host paths.");
  }
  return {
    role: input.role,
    file_name: input.file_name,
    measurement_scope: input.measurement_scope,
    byte_length: input.value.byteLength,
    sha256: sha256(input.value),
  };
}

export async function bindRecordingV3EvidenceFile(input: {
  role: string;
  file_path: string;
  measurement_scope: RecordingMeasurementScopeV3;
  artifact_file_name?: string;
}): Promise<RecordingV3EvidenceBinding> {
  const fileName = input.artifact_file_name ?? path.basename(input.file_path);
  assertSafeEvidenceName(input.role);
  assertSafeEvidenceName(fileName);
  if (path.basename(fileName) !== fileName) {
    throw new Error("Evidence bindings use artifact-local file names, not host paths.");
  }
  const [stat, digest] = await Promise.all([fs.stat(input.file_path), sha256File(input.file_path)]);
  if (!stat.isFile()) throw new Error("Certification evidence input must be a file.");
  return {
    role: input.role,
    file_name: fileName,
    measurement_scope: input.measurement_scope,
    byte_length: stat.size,
    sha256: digest,
  };
}

export function createRecordingV3RuntimeIntegrityQualityEvidence(input: {
  evaluated_frames: number;
  passed: boolean;
  failure_codes?: RecordingFailureCodeV3[];
}): RecordingQualityEvidenceV3 {
  if (!Number.isSafeInteger(input.evaluated_frames) || input.evaluated_frames < 0) {
    throw new Error("Runtime integrity evaluated_frames must be a non-negative safe integer.");
  }
  if (input.passed && (input.failure_codes?.length ?? 0) > 0) {
    throw new Error("Passed runtime integrity evidence cannot contain failure codes.");
  }
  return {
    version: 3,
    measurement_scope: "runtime_integrity",
    reference_identity: null,
    evaluated_frames: input.evaluated_frames,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes_match: input.passed,
    certification_verdict: null,
    verdict: input.passed ? "passed" : "failed",
    failure_codes: input.failure_codes ?? (input.passed ? [] : ["runtime_integrity_failed"]),
  };
}

export function createRecordingV3CertificationEvidenceArtifact(input: {
  fixture_id: string;
  fixture_version: string;
  generated_at: string;
  inputs: RecordingV3EvidenceBinding[];
  outputs: RecordingV3EvidenceBinding[];
  quality_evidence: RecordingQualityEvidenceV3;
}): CanonicalRecordingV3CertificationEvidenceArtifact {
  if (
    input.quality_evidence.measurement_scope !== "certification_fixture" ||
    input.quality_evidence.reference_identity === null
  ) {
    throw new Error("Certification evidence requires a fixture-scoped quality comparison.");
  }
  if (
    input.quality_evidence.reference_identity.fixture_id !== input.fixture_id ||
    input.quality_evidence.reference_identity.fixture_version !== input.fixture_version
  ) {
    throw new Error("Certification fixture identity does not match the quality reference.");
  }
  if (!Number.isFinite(Date.parse(input.generated_at))) {
    throw new Error("Certification evidence generated_at must be an ISO timestamp.");
  }
  if (input.inputs.length === 0 || input.outputs.length === 0) {
    throw new Error("Certification evidence must bind every input and output artifact.");
  }
  const bindings = [...input.inputs, ...input.outputs];
  if (bindings.some((binding) => binding.measurement_scope !== "certification_fixture")) {
    throw new Error("Runtime evidence must remain separate from certification fixture evidence.");
  }
  const identities = bindings.map((binding) => `${binding.role}:${binding.file_name}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Certification evidence bindings must have unique role/file identities.");
  }
  const referenceMaster = input.inputs.find((binding) => binding.role === "reference_master");
  if (
    !referenceMaster ||
    referenceMaster.sha256 !== input.quality_evidence.reference_identity.reference_sha256
  ) {
    throw new Error("Reference master hash does not match the quality reference identity.");
  }
  const qualityOutput = input.outputs.find((binding) => binding.role === "quality_evidence");
  const canonicalQuality = canonicalizeRecordingCertificationJson(input.quality_evidence);
  if (!qualityOutput || qualityOutput.sha256 !== sha256(canonicalQuality)) {
    throw new Error("Quality output binding does not match the canonical quality evidence.");
  }
  const artifact: RecordingV3CertificationEvidenceArtifact = {
    schema_version: 1,
    measurement_scope: "certification_fixture",
    fixture_id: input.fixture_id,
    fixture_version: input.fixture_version,
    generated_at: input.generated_at,
    inputs: input.inputs,
    outputs: input.outputs,
    quality_evidence: input.quality_evidence,
  };
  const canonicalJson = canonicalizeRecordingCertificationJson(artifact);
  return { artifact, canonical_json: canonicalJson, sha256: sha256(canonicalJson) };
}

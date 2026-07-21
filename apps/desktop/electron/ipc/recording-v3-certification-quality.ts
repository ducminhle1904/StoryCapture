import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import type {
  RecordingFixtureReferenceV3,
  RecordingQualityEvidenceV3,
} from "@storycapture/shared-types/recording-v2";

import {
  type RecordingFrameComparison,
  verifyRecordingQuality,
} from "./recording-quality-verifier";
import type {
  FixturePoint,
  FixtureRect,
  RecordingVerifierFixtureManifest,
} from "./recording-verifier-fixture";

export interface RecordingV3BrowserCertificationFixture {
  fixture_id: string;
  fixture_version: string;
  width: number;
  height: number;
  fps: { numerator: 60; denominator: 1 };
  pixel_format: "bgra";
  ordinal_roi: FixtureRect;
  timestamp_roi: FixtureRect;
  text_edge_rois: FixtureRect[];
  one_pixel_edge_roi: FixtureRect;
  geometry_anchor_roi: FixtureRect;
  color_block_roi: FixtureRect;
  high_motion_roi: FixtureRect;
  color_samples: FixturePoint[];
}

export interface RecordingV3CertificationFrameComparison {
  ordinal: number;
  reference: Buffer;
  candidate: Buffer;
}

export interface RecordingV3DecodedCertificationFrame {
  ordinal: number;
  bgra: Buffer;
  sha256: string;
}

export interface RecordingV3CertificationMasterComparison {
  reference_frames: RecordingV3DecodedCertificationFrame[];
  candidate_frames: RecordingV3DecodedCertificationFrame[];
  quality_evidence: RecordingQualityEvidenceV3;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asVerifierManifest(
  fixture: RecordingV3BrowserCertificationFixture,
): RecordingVerifierFixtureManifest {
  if (fixture.width !== 1920 || fixture.height !== 1080) {
    throw new Error(
      `Certification fixture must be 1920x1080, got ${fixture.width}x${fixture.height}.`,
    );
  }
  return {
    version: 1,
    kind: "motion",
    width: 1920,
    height: 1080,
    fps: fixture.fps,
    default_frame_count: 3600,
    text_sizes_px: [12, 16, 24, 42],
    text_edge_rois: fixture.text_edge_rois,
    one_pixel_edge_roi: fixture.one_pixel_edge_roi,
    checkerboard_roi: fixture.one_pixel_edge_roi,
    overlay_roi: fixture.geometry_anchor_roi,
    chroma_samples: fixture.color_samples,
    motion_roi: fixture.high_motion_roi,
    ordinal_roi: null,
    ordinal_bits: 24,
  };
}

function decodeBits(frame: Buffer, width: number, roi: FixtureRect, bits: number): number {
  let value = 0;
  for (let bit = 0; bit < bits; bit += 1) {
    const x = roi.x + bit * 26 + 10;
    const y = roi.y + 20;
    const offset = (y * width + x) * 4;
    const luma = frame[offset] * 0.0722 + frame[offset + 1] * 0.7152 + frame[offset + 2] * 0.2126;
    if (luma >= 96) value += 2 ** bit;
  }
  return value;
}

export function decodeRecordingV3FixtureOrdinal(
  frame: Buffer,
  fixture: RecordingV3BrowserCertificationFixture,
): number {
  return decodeBits(frame, fixture.width, fixture.ordinal_roi, 24);
}

export function decodeRecordingV3FixtureTimestampUs(
  frame: Buffer,
  fixture: RecordingV3BrowserCertificationFixture,
): number {
  return decodeBits(frame, fixture.width, fixture.timestamp_roi, 32);
}

export function verifyRecordingV3CertificationQuality(input: {
  fixture: RecordingV3BrowserCertificationFixture;
  reference_identity: RecordingFixtureReferenceV3;
  frames: readonly RecordingV3CertificationFrameComparison[];
}): RecordingQualityEvidenceV3 {
  const frameComparisons: RecordingFrameComparison[] = input.frames.map((frame) => ({
    reference: frame.reference,
    actual: frame.candidate,
  }));
  const embeddedIdentityMatches = input.frames.every((frame) => {
    const expectedTimestampUs = Math.round((frame.ordinal * 1_000_000) / 60) % 2 ** 32;
    return (
      decodeRecordingV3FixtureOrdinal(frame.reference, input.fixture) === frame.ordinal &&
      decodeRecordingV3FixtureOrdinal(frame.candidate, input.fixture) === frame.ordinal &&
      decodeRecordingV3FixtureTimestampUs(frame.reference, input.fixture) === expectedTimestampUs &&
      decodeRecordingV3FixtureTimestampUs(frame.candidate, input.fixture) === expectedTimestampUs
    );
  });
  const frameHashesMatch = input.frames.every(
    (frame) => sha256(frame.reference) === sha256(frame.candidate),
  );
  const evidence = verifyRecordingQuality({
    profile: "software",
    manifest: asVerifierManifest(input.fixture),
    frames: frameComparisons,
    lossless_master_hashes_match: frameHashesMatch && embeddedIdentityMatches,
  });
  const passed = evidence.verdict === "passed";
  return {
    version: 3,
    measurement_scope: "certification_fixture",
    reference_identity: input.reference_identity,
    evaluated_frames: evidence.evaluated_frames,
    full_frame_luma_ssim: evidence.full_frame_luma_ssim,
    text_edge_roi_ssim: evidence.text_edge_roi_ssim,
    p01_edge_contrast_retention: evidence.p01_edge_contrast_retention,
    edge_spread_increase_px: evidence.edge_spread_increase_px,
    overlay_geometry_delta_px: evidence.overlay_geometry_delta_px,
    color_channel_delta: evidence.color_channel_delta,
    lossless_master_hashes_match: evidence.lossless_master_hashes_match,
    certification_verdict: passed ? "passed" : "failed",
    verdict: passed ? "passed" : "failed",
    failure_codes: passed ? [] : ["artifact_verification_failed"],
  };
}

export async function decodeRecordingV3CertificationMasterFrames(input: {
  ffmpeg_path: string;
  master_path: string;
  width: number;
  height: number;
  ordinals: readonly number[];
}): Promise<RecordingV3DecodedCertificationFrame[]> {
  if (
    input.ordinals.length === 0 ||
    input.ordinals.length > 32 ||
    input.ordinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0) ||
    new Set(input.ordinals).size !== input.ordinals.length
  ) {
    throw new Error("Certification decode requires 1-32 unique non-negative frame ordinals.");
  }
  const ordinals = [...input.ordinals].sort((left, right) => left - right);
  const selection = ordinals.map((ordinal) => `eq(n\\,${ordinal})`).join("+");
  const child = spawn(
    input.ffmpeg_path,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input.master_path,
      "-map",
      "0:v:0",
      "-vf",
      `select=${selection}`,
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "bgra",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let errorBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes < 16_384) {
      errors.push(chunk);
      errorBytes += chunk.byteLength;
    }
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `FFmpeg certification decode failed with code ${exitCode}: ${Buffer.concat(errors).toString("utf8").trim()}`,
    );
  }
  const decoded = Buffer.concat(chunks);
  const frameBytes = input.width * input.height * 4;
  if (decoded.byteLength !== frameBytes * ordinals.length) {
    throw new Error(
      `Decoded ${decoded.byteLength} bytes; expected ${frameBytes * ordinals.length} for ${ordinals.length} frames.`,
    );
  }
  return ordinals.map((ordinal, index) => {
    const bgra = Buffer.from(decoded.subarray(index * frameBytes, (index + 1) * frameBytes));
    return { ordinal, bgra, sha256: sha256(bgra) };
  });
}

export async function compareRecordingV3CertificationMasters(input: {
  ffmpeg_path: string;
  reference_master_path: string;
  candidate_master_path: string;
  fixture: RecordingV3BrowserCertificationFixture;
  reference_identity: RecordingFixtureReferenceV3;
  ordinals: readonly number[];
}): Promise<RecordingV3CertificationMasterComparison> {
  const decodeInput = {
    ffmpeg_path: input.ffmpeg_path,
    width: input.fixture.width,
    height: input.fixture.height,
    ordinals: input.ordinals,
  };
  const referenceFrames = await decodeRecordingV3CertificationMasterFrames({
    ...decodeInput,
    master_path: input.reference_master_path,
  });
  const candidateFrames = await decodeRecordingV3CertificationMasterFrames({
    ...decodeInput,
    master_path: input.candidate_master_path,
  });
  return {
    reference_frames: referenceFrames,
    candidate_frames: candidateFrames,
    quality_evidence: verifyRecordingV3CertificationQuality({
      fixture: input.fixture,
      reference_identity: input.reference_identity,
      frames: referenceFrames.map((reference, index) => ({
        ordinal: decodeRecordingV3FixtureOrdinal(reference.bgra, input.fixture),
        reference: reference.bgra,
        candidate: candidateFrames[index].bgra,
      })),
    }),
  };
}

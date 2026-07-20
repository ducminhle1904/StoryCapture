import type {
  RecordingQualityEvidenceDto,
  RecordingQualityFailureCode,
  RecordingQualityMetricV2,
} from "@storycapture/shared-types/recording-v2";

import {
  findPixelBounds,
  frameSsim,
  maximumBoundsDelta,
  maximumColorDelta,
  type PixelBounds,
  sampleBgra,
} from "./export-quality-gate";
import {
  decodeFixtureOrdinal,
  type FixtureRect,
  type RecordingVerifierFixtureManifest,
} from "./recording-verifier-fixture";

export type RecordingStrictQualityProfile = "software" | "hardware";

export interface RecordingFrameComparison {
  reference: Buffer;
  actual: Buffer;
  expected_ordinal?: number;
}

export interface RecordingQualityVerificationInput {
  profile: RecordingStrictQualityProfile;
  manifest: RecordingVerifierFixtureManifest;
  frames: readonly RecordingFrameComparison[];
  lossless_master_hashes_match?: boolean | null;
  initial_failure_codes?: readonly RecordingQualityFailureCode[];
}

export const RECORDING_STRICT_QUALITY_THRESHOLDS = {
  software: {
    full_frame_luma_ssim: 0.995,
    text_edge_roi_ssim: 0.99,
    p01_edge_contrast_retention: 0.9,
    edge_spread_increase_px: 1,
    overlay_geometry_delta_px: 1,
    color_channel_delta: 24,
  },
  hardware: {
    full_frame_luma_ssim: 0.985,
    text_edge_roi_ssim: 0.975,
    p01_edge_contrast_retention: 0.85,
    edge_spread_increase_px: 1,
    overlay_geometry_delta_px: 1,
    color_channel_delta: 24,
  },
} as const;

function lumaAt(frame: Buffer, width: number, x: number, y: number): number {
  const offset = (y * width + x) * 4;
  return 0.0722 * frame[offset] + 0.7152 * frame[offset + 1] + 0.2126 * frame[offset + 2];
}

function cropFrame(frame: Buffer, width: number, height: number, roi: FixtureRect): Buffer {
  if (
    roi.x < 0 ||
    roi.y < 0 ||
    roi.width <= 0 ||
    roi.height <= 0 ||
    roi.x + roi.width > width ||
    roi.y + roi.height > height
  ) {
    throw new Error(`Fixture ROI is outside ${width}x${height}: ${JSON.stringify(roi)}.`);
  }
  const cropped = Buffer.allocUnsafe(roi.width * roi.height * 4);
  for (let row = 0; row < roi.height; row += 1) {
    const sourceStart = ((roi.y + row) * width + roi.x) * 4;
    frame.copy(cropped, row * roi.width * 4, sourceStart, sourceStart + roi.width * 4);
  }
  return cropped;
}

export function p01EdgeContrastRetention(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
  roi: FixtureRect,
): number {
  const referenceRoi = cropFrame(reference, width, height, roi);
  const actualRoi = cropFrame(actual, width, height, roi);
  const ratios: number[] = [];
  for (let y = 0; y < roi.height - 1; y += 1) {
    for (let x = 0; x < roi.width - 1; x += 1) {
      const referenceCenter = lumaAt(referenceRoi, roi.width, x, y);
      const actualCenter = lumaAt(actualRoi, roi.width, x, y);
      const referenceGradient = Math.max(
        Math.abs(lumaAt(referenceRoi, roi.width, x + 1, y) - referenceCenter),
        Math.abs(lumaAt(referenceRoi, roi.width, x, y + 1) - referenceCenter),
      );
      if (referenceGradient < 32) continue;
      const actualGradient = Math.max(
        Math.abs(lumaAt(actualRoi, roi.width, x + 1, y) - actualCenter),
        Math.abs(lumaAt(actualRoi, roi.width, x, y + 1) - actualCenter),
      );
      ratios.push(actualGradient / referenceGradient);
    }
  }
  if (ratios.length === 0) return 0;
  ratios.sort((left, right) => left - right);
  return ratios[Math.floor((ratios.length - 1) * 0.01)];
}

function transitionWidth(samples: number[]): number {
  const minimum = Math.min(...samples);
  const maximum = Math.max(...samples);
  if (maximum - minimum < 8) return samples.length - 1;
  const increasing = samples[samples.length - 1] >= samples[0];
  const normalized = samples.map((sample) => {
    const value = (sample - minimum) / (maximum - minimum);
    return increasing ? value : 1 - value;
  });
  const low = normalized.findIndex((value) => value >= 0.1);
  const high = normalized.findIndex((value) => value >= 0.9);
  if (low < 0 || high < 0) return samples.length - 1;
  return Math.max(0, high - low);
}

function edgeWidths(frame: Buffer, width: number, height: number, bounds: PixelBounds): number[] {
  const radius = 8;
  const centerX = Math.floor((bounds.left + bounds.right) / 2);
  const centerY = Math.floor((bounds.top + bounds.bottom) / 2);
  const horizontal = (position: number) => {
    const samples: number[] = [];
    for (let x = position - radius; x <= position + radius; x += 1) {
      samples.push(lumaAt(frame, width, Math.max(0, Math.min(width - 1, x)), centerY));
    }
    return transitionWidth(samples);
  };
  const vertical = (position: number) => {
    const samples: number[] = [];
    for (let y = position - radius; y <= position + radius; y += 1) {
      samples.push(lumaAt(frame, width, centerX, Math.max(0, Math.min(height - 1, y))));
    }
    return transitionWidth(samples);
  };
  return [
    horizontal(bounds.left),
    horizontal(bounds.right),
    vertical(bounds.top),
    vertical(bounds.bottom),
  ];
}

function markerBounds(frame: Buffer, width: number, height: number): PixelBounds | null {
  return findPixelBounds(
    frame,
    width,
    height,
    ({ red, green, blue }) =>
      red >= 180 && green >= 12 && green <= 96 && blue >= 140 && blue <= 230,
  );
}

export function edgeSpreadIncrease(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): number {
  const referenceBounds = markerBounds(reference, width, height);
  const actualBounds = markerBounds(actual, width, height);
  if (!referenceBounds || !actualBounds) return 16;
  const referenceWidths = edgeWidths(reference, width, height, referenceBounds);
  const actualWidths = edgeWidths(actual, width, height, actualBounds);
  return Math.max(
    0,
    ...actualWidths.map((actualWidth, index) => actualWidth - referenceWidths[index]),
  );
}

function metric(
  measured: number,
  threshold: number,
  comparator: "gte" | "lte",
): RecordingQualityMetricV2 {
  return {
    measured,
    threshold,
    comparator,
    passed: comparator === "gte" ? measured >= threshold : measured <= threshold,
  };
}

function addFailureCode(
  failureCodes: RecordingQualityFailureCode[],
  code: RecordingQualityFailureCode,
): void {
  if (!failureCodes.includes(code)) failureCodes.push(code);
}

export function exactLosslessMasterQualityEvidence(
  evaluatedFrames: number,
  hashesMatch: boolean,
  initialFailureCodes: readonly RecordingQualityFailureCode[] = [],
): RecordingQualityEvidenceDto {
  const failureCodes = [...initialFailureCodes];
  if (!Number.isSafeInteger(evaluatedFrames) || evaluatedFrames <= 0) {
    addFailureCode(failureCodes, "contract_mismatch");
  }
  if (!hashesMatch) addFailureCode(failureCodes, "artifact_hash_mismatch");
  const passed = failureCodes.length === 0;
  const thresholds = RECORDING_STRICT_QUALITY_THRESHOLDS.software;
  return {
    version: 2,
    evaluated_frames: Math.max(0, evaluatedFrames),
    full_frame_luma_ssim: passed ? metric(1, thresholds.full_frame_luma_ssim, "gte") : null,
    text_edge_roi_ssim: passed ? metric(1, thresholds.text_edge_roi_ssim, "gte") : null,
    p01_edge_contrast_retention: passed
      ? metric(1, thresholds.p01_edge_contrast_retention, "gte")
      : null,
    edge_spread_increase_px: passed ? metric(0, thresholds.edge_spread_increase_px, "lte") : null,
    overlay_geometry_delta_px: passed
      ? metric(0, thresholds.overlay_geometry_delta_px, "lte")
      : null,
    color_channel_delta: passed ? metric(0, thresholds.color_channel_delta, "lte") : null,
    lossless_master_hashes_match: hashesMatch,
    verdict: passed ? "passed" : "failed",
    failure_codes: failureCodes,
  };
}

export function verifyRecordingQuality(
  input: RecordingQualityVerificationInput,
): RecordingQualityEvidenceDto {
  const failureCodes = [...(input.initial_failure_codes ?? [])];
  if (input.frames.length === 0) {
    addFailureCode(failureCodes, "contract_mismatch");
    return {
      version: 2,
      evaluated_frames: 0,
      full_frame_luma_ssim: null,
      text_edge_roi_ssim: null,
      p01_edge_contrast_retention: null,
      edge_spread_increase_px: null,
      overlay_geometry_delta_px: null,
      color_channel_delta: null,
      lossless_master_hashes_match: input.lossless_master_hashes_match ?? null,
      verdict: "failed",
      failure_codes: failureCodes,
    };
  }

  const { width, height } = input.manifest;
  let minimumFullFrameSsim = 1;
  let minimumRoiSsim = 1;
  let minimumEdgeContrast = Number.POSITIVE_INFINITY;
  let maximumEdgeSpread = 0;
  let maximumGeometryDelta = 0;
  let maximumChannelDelta = 0;
  let ordinalMismatch = false;

  for (let frameIndex = 0; frameIndex < input.frames.length; frameIndex += 1) {
    const comparison = input.frames[frameIndex];
    minimumFullFrameSsim = Math.min(
      minimumFullFrameSsim,
      frameSsim(comparison.reference, comparison.actual, width, height),
    );
    for (const roi of [...input.manifest.text_edge_rois, input.manifest.one_pixel_edge_roi]) {
      const referenceRoi = cropFrame(comparison.reference, width, height, roi);
      const actualRoi = cropFrame(comparison.actual, width, height, roi);
      minimumRoiSsim = Math.min(
        minimumRoiSsim,
        frameSsim(referenceRoi, actualRoi, roi.width, roi.height),
      );
    }
    minimumEdgeContrast = Math.min(
      minimumEdgeContrast,
      p01EdgeContrastRetention(
        comparison.reference,
        comparison.actual,
        width,
        height,
        input.manifest.one_pixel_edge_roi,
      ),
    );
    maximumEdgeSpread = Math.max(
      maximumEdgeSpread,
      edgeSpreadIncrease(comparison.reference, comparison.actual, width, height),
    );
    const referenceBounds = markerBounds(comparison.reference, width, height);
    const actualBounds = markerBounds(comparison.actual, width, height);
    maximumGeometryDelta = Math.max(
      maximumGeometryDelta,
      referenceBounds && actualBounds ? maximumBoundsDelta(referenceBounds, actualBounds) : 16,
    );
    for (const point of input.manifest.chroma_samples) {
      maximumChannelDelta = Math.max(
        maximumChannelDelta,
        maximumColorDelta(
          sampleBgra(comparison.reference, width, height, point.x, point.y),
          sampleBgra(comparison.actual, width, height, point.x, point.y),
        ),
      );
    }
    if (
      input.manifest.ordinal_roi &&
      decodeFixtureOrdinal(comparison.actual) !== (comparison.expected_ordinal ?? frameIndex)
    ) {
      ordinalMismatch = true;
    }
  }

  const thresholds = RECORDING_STRICT_QUALITY_THRESHOLDS[input.profile];
  const fullFrame = metric(minimumFullFrameSsim, thresholds.full_frame_luma_ssim, "gte");
  const textEdge = metric(minimumRoiSsim, thresholds.text_edge_roi_ssim, "gte");
  const edgeContrast = metric(minimumEdgeContrast, thresholds.p01_edge_contrast_retention, "gte");
  const edgeSpread = metric(maximumEdgeSpread, thresholds.edge_spread_increase_px, "lte");
  const geometry = metric(maximumGeometryDelta, thresholds.overlay_geometry_delta_px, "lte");
  const color = metric(maximumChannelDelta, thresholds.color_channel_delta, "lte");

  if (!fullFrame.passed) addFailureCode(failureCodes, "visual_full_frame_ssim");
  if (!textEdge.passed) addFailureCode(failureCodes, "visual_text_edge_ssim");
  if (!edgeContrast.passed) addFailureCode(failureCodes, "visual_edge_contrast");
  if (!edgeSpread.passed) addFailureCode(failureCodes, "visual_edge_spread");
  if (!geometry.passed) addFailureCode(failureCodes, "visual_overlay_geometry");
  if (!color.passed) addFailureCode(failureCodes, "visual_color_delta");
  if (ordinalMismatch || input.lossless_master_hashes_match !== true) {
    addFailureCode(failureCodes, "artifact_hash_mismatch");
  }

  return {
    version: 2,
    evaluated_frames: input.frames.length,
    full_frame_luma_ssim: fullFrame,
    text_edge_roi_ssim: textEdge,
    p01_edge_contrast_retention: edgeContrast,
    edge_spread_increase_px: edgeSpread,
    overlay_geometry_delta_px: geometry,
    color_channel_delta: color,
    lossless_master_hashes_match: input.lossless_master_hashes_match ?? null,
    verdict: failureCodes.length === 0 ? "passed" : "failed",
    failure_codes: failureCodes,
  };
}

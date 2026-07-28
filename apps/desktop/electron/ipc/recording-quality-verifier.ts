import type {
  RecordingQualityEvidenceDto,
  RecordingQualityFailureCode,
  RecordingQualityMetricV2,
} from "@storycapture/shared-types/recording-v2";
import type {
  RecordingQualityEvidenceV3,
  RecordingV3FailureCode,
} from "@storycapture/shared-types/recording-v3";

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
  require_lossless_hash?: boolean;
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

export function sampledFrameAlignmentError(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): number {
  const expectedBytes = width * height * 4;
  if (reference.byteLength !== expectedBytes || actual.byteLength !== expectedBytes) {
    return Number.POSITIVE_INFINITY;
  }
  let total = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      total += Math.abs(lumaAt(reference, width, x, y) - lumaAt(actual, width, x, y));
      samples += 1;
    }
  }
  return total / samples;
}

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
  if (
    ordinalMismatch ||
    ((input.require_lossless_hash ?? true) && input.lossless_master_hashes_match !== true)
  ) {
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

export function verifyRecordingQualityV3(
  input: Omit<
    RecordingQualityVerificationInput,
    "lossless_master_hashes_match" | "require_lossless_hash"
  >,
): RecordingQualityEvidenceV3 {
  const evidence = verifyRecordingQuality({
    ...input,
    lossless_master_hashes_match: null,
    require_lossless_hash: false,
  });
  return {
    version: 3,
    evaluated_frames: evidence.evaluated_frames,
    full_frame_luma_ssim: evidence.full_frame_luma_ssim,
    text_edge_roi_ssim: evidence.text_edge_roi_ssim,
    p01_edge_contrast_retention: evidence.p01_edge_contrast_retention,
    edge_spread_increase_px: evidence.edge_spread_increase_px,
    overlay_geometry_delta_px: evidence.overlay_geometry_delta_px,
    color_channel_delta: evidence.color_channel_delta,
    lossless_master_hashes: "not_applicable",
    verdict: evidence.verdict,
    failure_codes: evidence.failure_codes as RecordingV3FailureCode[],
  };
}

export interface GenericRecordingFrameComparison {
  reference: Buffer;
  actual: Buffer;
}

function histogramPercentile(counts: Uint32Array, total: number, quantile: number): number {
  if (total === 0) return 0;
  const target = Math.min(total - 1, Math.floor(total * quantile));
  let seen = 0;
  for (let index = 0; index < counts.length; index += 1) {
    seen += counts[index] ?? 0;
    if (seen > target) return index;
  }
  return counts.length - 1;
}

function genericEdgeAndColorMetrics(
  reference: Buffer,
  actual: Buffer,
  width: number,
  height: number,
): { edgeSimilarity: number; contrastRetention: number; colorDelta: number } {
  const edgeSimilarities = new Uint32Array(256);
  const contrastScale = 1_024;
  const contrastRatios = new Uint32Array(32 * contrastScale + 1);
  const colorDeltas = new Uint32Array(256);
  let edgeCount = 0;
  let colorCount = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 540));
  for (let y = step; y < height; y += step) {
    for (let x = step; x < width; x += step) {
      const current = (y * width + x) * 4;
      const left = (y * width + x - step) * 4;
      const above = ((y - step) * width + x) * 4;
      const referenceGradient = Math.max(
        Math.abs(lumaAt(reference, width, x, y) - lumaAt(reference, width, x - step, y)),
        Math.abs(lumaAt(reference, width, x, y) - lumaAt(reference, width, x, y - step)),
      );
      const actualGradient = Math.max(
        Math.abs(lumaAt(actual, width, x, y) - lumaAt(actual, width, x - step, y)),
        Math.abs(lumaAt(actual, width, x, y) - lumaAt(actual, width, x, y - step)),
      );
      if (referenceGradient >= 12) {
        const similarity = 255 - Math.min(255, Math.abs(referenceGradient - actualGradient));
        edgeSimilarities[similarity] += 1;
        const contrast = Math.min(
          contrastRatios.length - 1,
          Math.round((actualGradient / referenceGradient) * contrastScale),
        );
        contrastRatios[contrast] += 1;
        edgeCount += 1;
      }
      const colorDelta = Math.max(
        Math.abs(reference[current] - actual[current]),
        Math.abs(reference[current + 1] - actual[current + 1]),
        Math.abs(reference[current + 2] - actual[current + 2]),
        Math.abs(reference[left] - actual[left]),
        Math.abs(reference[above] - actual[above]),
      );
      colorDeltas[colorDelta] += 1;
      colorCount += 1;
    }
  }
  return {
    edgeSimilarity: histogramPercentile(edgeSimilarities, edgeCount, 0.01) / 255,
    contrastRetention: histogramPercentile(contrastRatios, edgeCount, 0.01) / contrastScale,
    colorDelta: histogramPercentile(colorDeltas, colorCount, 0.99),
  };
}

export function verifyGenericRecordingQualityV3(input: {
  width: number;
  height: number;
  frames: readonly GenericRecordingFrameComparison[];
}): RecordingQualityEvidenceV3 {
  const failures: RecordingV3FailureCode[] = [];
  if (input.frames.length === 0) {
    return {
      version: 3,
      evaluated_frames: 0,
      full_frame_luma_ssim: null,
      text_edge_roi_ssim: null,
      p01_edge_contrast_retention: null,
      edge_spread_increase_px: null,
      overlay_geometry_delta_px: null,
      color_channel_delta: null,
      lossless_master_hashes: "not_applicable",
      verdict: "failed",
      failure_codes: ["contract_mismatch"],
    };
  }
  const expectedBytes = input.width * input.height * 4;
  let minimumSsim = 1;
  let minimumEdgeSimilarity = 1;
  let minimumContrastRetention = Number.POSITIVE_INFINITY;
  let maximumColorDelta = 0;
  let evaluatedFrames = 0;
  for (const frame of input.frames) {
    if (frame.reference.byteLength !== expectedBytes || frame.actual.byteLength !== expectedBytes) {
      failures.push("contract_mismatch");
      continue;
    }
    evaluatedFrames += 1;
    minimumSsim = Math.min(
      minimumSsim,
      frameSsim(frame.reference, frame.actual, input.width, input.height),
    );
    const edge = genericEdgeAndColorMetrics(
      frame.reference,
      frame.actual,
      input.width,
      input.height,
    );
    minimumEdgeSimilarity = Math.min(minimumEdgeSimilarity, edge.edgeSimilarity);
    minimumContrastRetention = Math.min(minimumContrastRetention, edge.contrastRetention);
    maximumColorDelta = Math.max(maximumColorDelta, edge.colorDelta);
  }
  if (evaluatedFrames === 0) {
    return {
      version: 3,
      evaluated_frames: 0,
      full_frame_luma_ssim: null,
      text_edge_roi_ssim: null,
      p01_edge_contrast_retention: null,
      edge_spread_increase_px: null,
      overlay_geometry_delta_px: null,
      color_channel_delta: null,
      lossless_master_hashes: "not_applicable",
      verdict: "failed",
      failure_codes: failures,
    };
  }
  const thresholds = RECORDING_STRICT_QUALITY_THRESHOLDS.hardware;
  const fullFrame = metric(minimumSsim, thresholds.full_frame_luma_ssim, "gte");
  const textEdge = metric(minimumEdgeSimilarity, thresholds.text_edge_roi_ssim, "gte");
  const contrast = metric(minimumContrastRetention, thresholds.p01_edge_contrast_retention, "gte");
  const color = metric(maximumColorDelta, thresholds.color_channel_delta, "lte");
  if (!fullFrame.passed) failures.push("visual_full_frame_ssim");
  if (!textEdge.passed) failures.push("visual_text_edge_ssim");
  if (!contrast.passed) failures.push("visual_edge_contrast");
  if (!color.passed) failures.push("visual_color_delta");
  return {
    version: 3,
    evaluated_frames: evaluatedFrames,
    full_frame_luma_ssim: fullFrame,
    text_edge_roi_ssim: textEdge,
    p01_edge_contrast_retention: contrast,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: color,
    lossless_master_hashes: "not_applicable",
    verdict: failures.length === 0 ? "passed" : "failed",
    failure_codes: failures,
  };
}

import type { RecordingProbeResult } from "./media-probe";
import type { RecordingCadenceObservationV2 } from "./recording-cadence-verifier";

export type RecordingCadenceFault =
  | "missing_source_sequence"
  | "source_sequence_gap"
  | "stale_reuse"
  | "scheduled_skip"
  | "submitted_drop"
  | "ring_overflow"
  | "backpressure_deadline_miss"
  | "pts_gap"
  | "pts_duplicate"
  | "source_59_94";

export type RecordingArtifactFault = "truncation" | "resolution_mismatch";

export function createPassingCadenceObservation(frameCount = 300): RecordingCadenceObservationV2 {
  return {
    version: 2,
    requested_fps: { numerator: 60, denominator: 1 },
    source_fps: { numerator: 60, denominator: 1 },
    stream_time_base: { numerator: 1, denominator: 60_000 },
    active_duration_us: (frameCount * 1_000_000) / 60,
    expected_slots: frameCount,
    source_presentations: frameCount,
    submitted_frames: frameCount,
    encoder_acked_frames: frameCount,
    artifact_decoded_frames: frameCount,
    source_sequence_gaps: 0,
    stale_reuses: 0,
    skipped_slots: 0,
    dropped_frames: 0,
    deadline_misses: 0,
    ring_overflows: 0,
    backpressure_events: 0,
    pts_gaps: 0,
    pts_duplicates: 0,
    full_decode_succeeded: true,
  };
}

export function injectCadenceFault(
  source: RecordingCadenceObservationV2,
  fault: RecordingCadenceFault,
): RecordingCadenceObservationV2 {
  const observation = { ...source, failure_codes: [...(source.failure_codes ?? [])] };
  switch (fault) {
    case "missing_source_sequence":
      return { ...observation, source_presentations: Math.max(0, source.source_presentations - 1) };
    case "source_sequence_gap":
      return { ...observation, source_sequence_gaps: source.source_sequence_gaps + 1 };
    case "stale_reuse":
      return { ...observation, stale_reuses: source.stale_reuses + 1 };
    case "scheduled_skip":
      return {
        ...observation,
        submitted_frames: Math.max(0, source.submitted_frames - 1),
        skipped_slots: source.skipped_slots + 1,
      };
    case "submitted_drop":
      return {
        ...observation,
        encoder_acked_frames: Math.max(0, source.encoder_acked_frames - 1),
        dropped_frames: source.dropped_frames + 1,
      };
    case "ring_overflow":
      return { ...observation, ring_overflows: source.ring_overflows + 1 };
    case "backpressure_deadline_miss":
      return {
        ...observation,
        backpressure_events: source.backpressure_events + 1,
        deadline_misses: source.deadline_misses + 1,
      };
    case "pts_gap":
      return { ...observation, pts_gaps: source.pts_gaps + 1 };
    case "pts_duplicate":
      return { ...observation, pts_duplicates: source.pts_duplicates + 1 };
    case "source_59_94":
      return { ...observation, source_fps: { numerator: 60_000, denominator: 1_001 } };
  }
}

export function injectArtifactFault(
  source: Extract<RecordingProbeResult, { status: "valid" }>,
  fault: RecordingArtifactFault,
): Extract<RecordingProbeResult, { status: "valid" }> {
  switch (fault) {
    case "truncation":
      return {
        ...source,
        duration_ms:
          source.duration_ms === null ? 1 : Math.max(1, Math.floor(source.duration_ms / 2)),
        counted_frames:
          source.counted_frames === null ? null : Math.max(0, source.counted_frames - 1),
        frames: source.frames.slice(0, -1),
      };
    case "resolution_mismatch":
      return { ...source, width: Math.max(1, source.width - 2) };
  }
}

export function injectOrdinalFault(frame: Buffer, width: number, height: number): Buffer {
  if (frame.byteLength !== width * height * 4) {
    throw new Error("Ordinal fault injection requires an exact BGRA frame.");
  }
  const corrupted = Buffer.from(frame);
  const ordinalBitX = 48 + 13;
  const ordinalBitY = 976 + 24;
  const offset = (ordinalBitY * width + ordinalBitX) * 4;
  const replacement = corrupted[offset] >= 128 ? 0 : 255;
  corrupted[offset] = replacement;
  corrupted[offset + 1] = replacement;
  corrupted[offset + 2] = replacement;
  return corrupted;
}

export function injectDownscaleUpscaleBlur(
  frame: Buffer,
  width: number,
  height: number,
  scale = 4,
): Buffer {
  if (frame.byteLength !== width * height * 4) {
    throw new Error("Blur fault injection requires an exact BGRA frame.");
  }
  if (!Number.isSafeInteger(scale) || scale < 2) {
    throw new Error("Blur fault scale must be an integer of at least two.");
  }
  const reducedWidth = Math.max(1, Math.floor(width / scale));
  const reducedHeight = Math.max(1, Math.floor(height / scale));
  const reduced = Buffer.alloc(reducedWidth * reducedHeight * 4);
  for (let y = 0; y < reducedHeight; y += 1) {
    for (let x = 0; x < reducedWidth; x += 1) {
      const sums = [0, 0, 0, 0];
      let samples = 0;
      for (let sourceY = y * scale; sourceY < Math.min(height, (y + 1) * scale); sourceY += 1) {
        for (let sourceX = x * scale; sourceX < Math.min(width, (x + 1) * scale); sourceX += 1) {
          const offset = (sourceY * width + sourceX) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += frame[offset + channel];
          samples += 1;
        }
      }
      const target = (y * reducedWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        reduced[target + channel] = Math.round(sums[channel] / samples);
      }
    }
  }

  const blurred = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y * (reducedHeight - 1)) / Math.max(1, height - 1);
    const top = Math.floor(sourceY);
    const bottom = Math.min(reducedHeight - 1, top + 1);
    const yWeight = sourceY - top;
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x * (reducedWidth - 1)) / Math.max(1, width - 1);
      const left = Math.floor(sourceX);
      const right = Math.min(reducedWidth - 1, left + 1);
      const xWeight = sourceX - left;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = reduced[(top * reducedWidth + left) * 4 + channel];
        const topRight = reduced[(top * reducedWidth + right) * 4 + channel];
        const bottomLeft = reduced[(bottom * reducedWidth + left) * 4 + channel];
        const bottomRight = reduced[(bottom * reducedWidth + right) * 4 + channel];
        const topValue = topLeft + (topRight - topLeft) * xWeight;
        const bottomValue = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        blurred[target + channel] = Math.round(topValue + (bottomValue - topValue) * yWeight);
      }
    }
  }
  return blurred;
}

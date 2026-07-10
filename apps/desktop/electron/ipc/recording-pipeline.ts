import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
  ScaleAlgoDto,
} from "@storycapture/shared-types";

export type RecordingFitMode = FitModeDto;
export type RecordingQualityPreset = Extract<
  QualityPresetDto,
  "high" | "lossless"
>;
export type RecordingScaleAlgo = ScaleAlgoDto;
export type RecordingOutputResolution = OutputResolutionDto;
export type RecordingPadColor = PadColorDto;

export interface RecordingOutputOptions {
  outputResolution?: RecordingOutputResolution | null;
  fitMode?: RecordingFitMode | null;
  padColor?: RecordingPadColor | null;
  qualityPreset?: RecordingQualityPreset | null;
  scaleAlgo?: RecordingScaleAlgo | null;
}

export interface ResolvedRecordingOutput {
  outputWidth: number;
  outputHeight: number;
  fitMode: RecordingFitMode;
  padColor: RecordingPadColor;
  qualityPreset: RecordingQualityPreset;
  scaleAlgo: RecordingScaleAlgo;
}

export interface CadenceWarningInput {
  actualFps: number;
  requestedFps: number;
  thresholdRatio?: number;
}

const DEFAULT_MAX_DIMENSION = 7680;

export function clampRecordingDimension(
  value: unknown,
  fallback: number,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(DEFAULT_MAX_DIMENSION, Math.round(numeric)));
}

export function resolveRecordingOutput(
  sourceWidth: number,
  sourceHeight: number,
  options: RecordingOutputOptions = {},
): ResolvedRecordingOutput {
  const source = {
    width: clampRecordingDimension(sourceWidth, 1920),
    height: clampRecordingDimension(sourceHeight, 1080),
  };
  const resolution = options.outputResolution ?? { kind: "match-source" };
  const size = (() => {
    switch (resolution.kind) {
      case "p720":
        return { outputWidth: 1280, outputHeight: 720 };
      case "p1080":
        return { outputWidth: 1920, outputHeight: 1080 };
      case "p1440":
        return { outputWidth: 2560, outputHeight: 1440 };
      case "p2160":
        return { outputWidth: 3840, outputHeight: 2160 };
      case "custom":
        return {
          outputWidth: clampRecordingDimension(resolution.w, source.width),
          outputHeight: clampRecordingDimension(resolution.h, source.height),
        };
      case "match-source":
      default:
        return { outputWidth: source.width, outputHeight: source.height };
    }
  })();

  return {
    ...size,
    fitMode: options.fitMode ?? "letterbox",
    padColor: options.padColor ?? { kind: "black" },
    qualityPreset: options.qualityPreset ?? "high",
    scaleAlgo: options.scaleAlgo ?? "lanczos",
  };
}

export function recordingRawVideoInputArgs(args: {
  width: number;
  height: number;
  fps: number;
  pixelFormat?: string;
}): string[] {
  return [
    "-f",
    "rawvideo",
    "-pix_fmt",
    args.pixelFormat ?? "bgra",
    "-s",
    `${args.width}x${args.height}`,
    "-framerate",
    String(args.fps),
    "-i",
    "pipe:0",
  ];
}

export function recordingPngSequenceInputArgs(fps: number): string[] {
  return ["-framerate", String(fps)];
}

export function recordingVideoFilters(args: {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  fitMode: RecordingFitMode;
  padColor: RecordingPadColor;
  scaleAlgo: RecordingScaleAlgo;
}): string[] {
  const scale = `${args.outputWidth}:${args.outputHeight}:flags=${args.scaleAlgo}`;
  if (args.fitMode === "stretch") {
    return [`scale=${scale}`, "format=yuv420p"];
  }
  if (args.fitMode === "fill-crop") {
    return [
      `scale=${args.outputWidth}:${args.outputHeight}:force_original_aspect_ratio=increase:flags=${args.scaleAlgo}`,
      `crop=${args.outputWidth}:${args.outputHeight}`,
      "format=yuv420p",
    ];
  }
  return [
    `scale=${args.outputWidth}:${args.outputHeight}:force_original_aspect_ratio=decrease:flags=${args.scaleAlgo}`,
    `pad=${args.outputWidth}:${args.outputHeight}:(ow-iw)/2:(oh-ih)/2:color=${ffmpegPadColor(args.padColor)}`,
    "format=yuv420p",
  ];
}

export function recordingQualityArgs(preset: RecordingQualityPreset): string[] {
  if (preset === "lossless") {
    return ["-preset", "veryfast", "-crf", "0"];
  }
  return ["-preset", "veryfast", "-crf", "18"];
}

export function cadenceWarning(
  input: CadenceWarningInput,
): { code: string; message: string } | null {
  const thresholdRatio = input.thresholdRatio ?? 0.8;
  if (
    !Number.isFinite(input.actualFps) ||
    !Number.isFinite(input.requestedFps) ||
    input.requestedFps <= 0
  ) {
    return null;
  }
  if (input.actualFps >= input.requestedFps * thresholdRatio) return null;
  return {
    code: "actual_capture_fps_below_requested",
    message: `Captured ${input.actualFps.toFixed(2)} fps; requested ${input.requestedFps.toFixed(2)} fps.`,
  };
}

function ffmpegPadColor(color: RecordingPadColor): string {
  if (color.kind === "white") return "white";
  if (color.kind === "black") return "black";
  const r = clampColorChannel(color.r);
  const g = clampColorChannel(color.g);
  const b = clampColorChannel(color.b);
  return `0x${hex(r)}${hex(g)}${hex(b)}`;
}

function clampColorChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

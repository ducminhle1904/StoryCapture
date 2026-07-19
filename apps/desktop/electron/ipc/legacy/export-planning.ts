import {
  EXPORT_FOREGROUND_SCALE_MAX,
  EXPORT_FOREGROUND_SCALE_MIN,
  isValidExportForegroundScale,
} from "@storycapture/shared-types/export-composition";
import type { ExportAudioPlan as CanonicalExportAudioPlan } from "./export-audio-planning";
import type { ExportEncoderOptions, ExportOutput } from "./shared";

type ExportFormat = "mp4" | "webm" | "gif";
type ExportQuality = "low" | "med" | "high";
type ExportContainer = "mp4" | "mov" | "webm";
type ExportCodec = "h264";
type ExportRateControl = "auto" | "cbr" | "vbr" | "crf" | "cq";
type ExportHardwareEncoder = NonNullable<ExportEncoderOptions["hw_encoder"]>;
type ExportResamplingQuality = "high" | "balanced" | "fast";
type ExportAudioCodec = "aac" | "opus";

interface ExportAudioPlan {
  codec: ExportAudioCodec;
  bitrateKbps: number;
  channels: number;
  sampleRateHz: number;
}

export interface NormalizedExportEncoderOptions {
  container: ExportContainer | null;
  codec: ExportCodec;
  rateControl: ExportRateControl;
  hwEncoder: ExportHardwareEncoder;
  qualityValue: number | null;
  encoderPreset: string | null;
  keyframeIntervalSec: number | null;
  resamplingQuality: ExportResamplingQuality;
  audio: ExportAudioPlan | null;
}

interface ExportSourceNode {
  type: "source";
  id?: string;
  path: string;
  pts_offset_ms?: number;
  duration_ms?: number;
  source_width?: number;
  source_height?: number;
  source_fps?: number;
  source_time_map?: unknown;
}

interface ExportGraph {
  schema_version?: number;
  output_width?: number;
  output_height?: number;
  output_fps?: number;
  duration_ms?: number;
  video?: Array<Record<string, unknown>>;
  audio?: Array<Record<string, unknown>>;
}

interface RunnableExportPlanBase {
  output: ExportOutput;
  graph: ExportGraph;
  source: ExportSourceNode;
  encoderOptions: NormalizedExportEncoderOptions;
}

export interface CompositedExportPlan extends RunnableExportPlanBase {
  kind: "composited";
  outputWidth: number;
  outputHeight: number;
  fps: number;
  durationMs: number;
  frameCount: number;
  pixelFormat: "bgra";
}

export type RunnableExportPlan = CompositedExportPlan;

export interface UnsupportedExportPlan {
  kind: "unsupported";
  output: ExportOutput;
  graph: ExportGraph | null;
  reason: string;
  requiredPlan?: "simple-concat" | "composited";
  unsupportedNodes?: string[];
}

export type ExportPlan = RunnableExportPlan | UnsupportedExportPlan;

const FORMATS = ["mp4", "webm", "gif"] as const;
const RESOLUTIONS = ["match-source", "720p", "1080p", "4k", "custom"] as const;
const QUALITIES = ["low", "med", "high"] as const;
const SUPPORTED_FPS = [24, 30, 60] as const;
const CONTAINERS = ["mp4", "mov", "webm"] as const;
const CODECS = ["h264"] as const;
const RATE_CONTROLS = ["auto", "cbr", "vbr", "crf", "cq"] as const;
const HARDWARE_ENCODERS = [
  "video-toolbox-h264",
  "video-toolbox-hevc",
  "nvenc-h264",
  "qsv-h264",
  "amf-h264",
  "libx264-software",
  "openh-264-software",
] as const;
const X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;
const SCALE_ALGOS = ["lanczos", "bicubic", "bilinear", "area"] as const;
const RESAMPLING_QUALITIES = ["high", "balanced", "fast"] as const;
const ENCODER_PRESETS: Partial<Record<ExportHardwareEncoder, readonly string[]>> = {
  "libx264-software": X264_PRESETS,
  "nvenc-h264": ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
  "video-toolbox-h264": ["speed", "quality"],
  "qsv-h264": ["veryfast", "faster", "fast", "medium", "slow", "slower"],
  "amf-h264": ["speed", "balanced", "quality"],
};
const AUDIO_CODECS = ["aac", "opus"] as const;

export const MP4_DELIVERY_PROFILE = {
  codec: "h264",
  profile: "high",
  pixelFormat: "yuv420p",
  colorPrimaries: "bt709",
  colorTransfer: "bt709",
  colorMatrix: "bt709",
  colorRange: "tv",
  defaultKeyframeIntervalSec: 2,
  crf: { high: 18, med: 22, low: 26 },
  hardwareBitrateCoefficient: { high: 0.12, med: 0.08, low: 0.05 },
  minHardwareBitrateMbps: 4,
  maxHardwareBitrateMbps: 100,
  maxrateMultiplier: 1.5,
  bufferMultiplier: 2,
} as const;

const MP4_ENCODER_CAPABILITIES: Partial<
  Record<
    ExportHardwareEncoder,
    {
      ffmpegName: string;
      rateControls: readonly ExportRateControl[];
      presets: readonly string[];
    }
  >
> = {
  "libx264-software": {
    ffmpegName: "libx264",
    rateControls: ["crf"],
    presets: X264_PRESETS,
  },
  "nvenc-h264": {
    ffmpegName: "h264_nvenc",
    rateControls: ["vbr"],
    presets: ENCODER_PRESETS["nvenc-h264"] ?? [],
  },
  "video-toolbox-h264": {
    ffmpegName: "h264_videotoolbox",
    rateControls: ["vbr"],
    presets: ENCODER_PRESETS["video-toolbox-h264"] ?? [],
  },
  "qsv-h264": {
    ffmpegName: "h264_qsv",
    rateControls: ["vbr"],
    presets: ENCODER_PRESETS["qsv-h264"] ?? [],
  },
  "amf-h264": {
    ffmpegName: "h264_amf",
    rateControls: ["vbr"],
    presets: ENCODER_PRESETS["amf-h264"] ?? [],
  },
};

const DEFAULT_MAX_DIMENSION = 7680;
const DEFAULT_AUDIO_BITRATE_KBPS = 192;
const DEFAULT_AUDIO_CHANNELS = 2;
const DEFAULT_AUDIO_SAMPLE_RATE_HZ = 48_000;
const SUPPORTED_COMPOSITOR_VIDEO_NODES = new Set([
  "source",
  "zoom-pan",
  "background",
  "cursor-overlay",
  "ripple-overlay",
  "highlight-overlay",
  "text-overlay",
  "transition",
]);

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

function assertEnum<T extends readonly string[]>(
  name: string,
  value: unknown,
  allowed: T,
): T[number] {
  const normalized = enumValue(value, allowed);
  if (!normalized) throw new Error(`unknown ${name}: ${String(value)}`);
  return normalized;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = finiteNumber(value);
  if (n === null) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampDimensionValue(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 16, DEFAULT_MAX_DIMENSION);
}

function clampFpsValue(value: unknown): number {
  return clampNumber(value, 60, 1, 240);
}

export function resolutionSize(output: ExportOutput): { width: number; height: number } | null {
  switch (output.resolution) {
    case "720p":
      return { width: 1280, height: 720 };
    case "1080p":
      return { width: 1920, height: 1080 };
    case "4k":
      return { width: 3840, height: 2160 };
    case "custom":
      return {
        width: clampDimensionValue(output.output_width, 1920),
        height: clampDimensionValue(output.output_height, 1080),
      };
    default:
      return null;
  }
}

export function normalizeExportEncoderOptions(
  output: ExportOutput,
): NormalizedExportEncoderOptions {
  const format = enumValue(output.format, FORMATS);
  const raw = output.encoder_options ?? {};
  const container =
    enumValue(raw.container, CONTAINERS) ?? (format === "mp4" || format === "webm" ? format : null);
  const defaultAudioCodec: ExportAudioCodec = format === "webm" ? "opus" : "aac";
  const rawAudio = raw.audio ?? {};
  const hwEncoder = enumValue(raw.hw_encoder, HARDWARE_ENCODERS) ?? "libx264-software";
  const rawRateControl = enumValue(raw.rate_control, RATE_CONTROLS) ?? "auto";
  const rateControl =
    rawRateControl === "auto"
      ? hwEncoder === "libx264-software"
        ? "crf"
        : hwEncoder === "openh-264-software"
          ? "cbr"
          : "vbr"
      : rawRateControl;
  const legacyResampling =
    raw.downscale_algo === "lanczos" || raw.downscale_algo === "area"
      ? "high"
      : raw.downscale_algo === "bicubic"
        ? "balanced"
        : raw.downscale_algo === "bilinear"
          ? "fast"
          : null;
  const encoderPreset =
    typeof raw.encoder_preset === "string"
      ? raw.encoder_preset
      : typeof raw.x264_preset === "string"
        ? raw.x264_preset
        : (defaultEncoderPreset(hwEncoder) ?? null);
  return {
    container,
    codec: enumValue(raw.codec, CODECS) ?? "h264",
    rateControl,
    hwEncoder,
    qualityValue: finiteNumber(raw.quality_value),
    encoderPreset,
    keyframeIntervalSec: finiteNumber(raw.keyframe_interval_sec),
    resamplingQuality:
      enumValue(raw.resampling_quality, RESAMPLING_QUALITIES) ?? legacyResampling ?? "high",
    audio:
      format === "gif"
        ? null
        : {
            codec: enumValue(rawAudio.codec, AUDIO_CODECS) ?? defaultAudioCodec,
            bitrateKbps: clampNumber(rawAudio.bitrate_kbps, DEFAULT_AUDIO_BITRATE_KBPS, 16, 1024),
            channels: clampNumber(rawAudio.channels, DEFAULT_AUDIO_CHANNELS, 1, 8),
            sampleRateHz: clampNumber(
              rawAudio.sample_rate_hz,
              DEFAULT_AUDIO_SAMPLE_RATE_HZ,
              8_000,
              192_000,
            ),
          },
  };
}

function defaultEncoderPreset(encoder: ExportHardwareEncoder): string | null {
  switch (encoder) {
    case "libx264-software":
    case "qsv-h264":
      return "medium";
    case "nvenc-h264":
      return "p4";
    case "video-toolbox-h264":
      return "quality";
    case "amf-h264":
      return "balanced";
    default:
      return null;
  }
}

function allowedRateControls(encoder: ExportHardwareEncoder): readonly ExportRateControl[] {
  return MP4_ENCODER_CAPABILITIES[encoder]?.rateControls ?? [];
}

export function validateExportOutput(output: ExportOutput): void {
  const format = assertEnum("format", output.format, FORMATS) as ExportFormat;
  assertEnum("resolution", output.resolution, RESOLUTIONS);
  if (!SUPPORTED_FPS.includes(output.fps as (typeof SUPPORTED_FPS)[number])) {
    throw new Error(`unsupported fps: ${String(output.fps)}`);
  }
  assertEnum("quality", output.quality, QUALITIES);
  if (output.resolution === "custom" && (!output.output_width || !output.output_height)) {
    throw new Error("custom resolution requires output_width and output_height");
  }

  const raw = output.encoder_options;
  const normalized = normalizeExportEncoderOptions(output);
  if (raw?.container && !enumValue(raw.container, CONTAINERS)) {
    throw new Error(`unsupported encoder container: ${String(raw.container)}`);
  }
  if (raw?.container && normalized.container !== format) {
    throw new Error(`encoder container ${raw.container} does not match export format ${format}`);
  }
  if (raw?.codec && !enumValue(raw.codec, CODECS)) {
    throw new Error(`unsupported video codec: ${String(raw.codec)}`);
  }
  if (raw?.rate_control && !enumValue(raw.rate_control, RATE_CONTROLS)) {
    throw new Error(`unsupported rate control: ${String(raw.rate_control)}`);
  }
  if (raw?.hw_encoder && !enumValue(raw.hw_encoder, HARDWARE_ENCODERS)) {
    throw new Error(`unsupported hardware encoder: ${String(raw.hw_encoder)}`);
  }
  if (raw?.hw_encoder === "video-toolbox-hevc") {
    throw new Error("HEVC hardware export is not supported by this H.264 export path");
  }
  if (raw?.x264_preset && !enumValue(raw.x264_preset, X264_PRESETS)) {
    throw new Error(`unsupported x264 preset: ${String(raw.x264_preset)}`);
  }
  if (raw?.encoder_preset !== undefined && raw.encoder_preset !== null) {
    if (typeof raw.encoder_preset !== "string") {
      throw new Error("encoder preset must be a string");
    }
  }
  if (raw?.downscale_algo && !enumValue(raw.downscale_algo, SCALE_ALGOS)) {
    throw new Error(`unsupported downscale algorithm: ${String(raw.downscale_algo)}`);
  }
  if (raw?.resampling_quality && !enumValue(raw.resampling_quality, RESAMPLING_QUALITIES)) {
    throw new Error(`unsupported resampling quality: ${String(raw.resampling_quality)}`);
  }
  if (format === "mp4" && !MP4_ENCODER_CAPABILITIES[normalized.hwEncoder]) {
    throw new Error(
      `encoder ${normalized.hwEncoder} is not supported by the bundled MP4 delivery path`,
    );
  }
  if (
    format === "mp4" &&
    !allowedRateControls(normalized.hwEncoder).includes(normalized.rateControl)
  ) {
    throw new Error(
      `rate control ${normalized.rateControl} is not supported by ${normalized.hwEncoder}`,
    );
  }
  const allowedPresets =
    format === "mp4"
      ? (MP4_ENCODER_CAPABILITIES[normalized.hwEncoder]?.presets ?? [])
      : (ENCODER_PRESETS[normalized.hwEncoder] ?? []);
  if (normalized.encoderPreset !== null && !allowedPresets.includes(normalized.encoderPreset)) {
    throw new Error(
      `encoder preset ${normalized.encoderPreset} is not supported by ${normalized.hwEncoder}`,
    );
  }
  if (normalized.hwEncoder === "libx264-software") {
    validateRange(normalized.qualityValue, "CRF quality", 0, 51);
  } else if (normalized.hwEncoder === "nvenc-h264") {
    validateRange(normalized.qualityValue, "NVENC CQ quality", 0, 51);
  } else if (normalized.rateControl === "cbr" || normalized.rateControl === "vbr") {
    validateRange(normalized.qualityValue, "video bitrate Mbps", 1, 100);
  }
  if (
    normalized.keyframeIntervalSec !== null &&
    (normalized.keyframeIntervalSec < 1 || normalized.keyframeIntervalSec > 10)
  ) {
    throw new Error("keyframe interval must be between 1 and 10 seconds");
  }
  if (raw?.audio?.codec && !enumValue(raw.audio.codec, AUDIO_CODECS)) {
    throw new Error(`unsupported audio codec: ${String(raw.audio.codec)}`);
  }
  if (normalized.audio) {
    if (format === "mp4" && normalized.audio.codec !== "aac") {
      throw new Error("MP4 export currently supports AAC audio only");
    }
    if (format === "webm" && normalized.audio.codec !== "opus") {
      throw new Error("WebM export currently supports Opus audio only");
    }
    if (
      format === "mp4" &&
      (normalized.audio.bitrateKbps !== 192 ||
        normalized.audio.channels !== 2 ||
        normalized.audio.sampleRateHz !== 48_000)
    ) {
      throw new Error("MP4 export requires AAC-LC audio at 192 kbps, 48 kHz, and stereo");
    }
  }
}

function validateRange(value: number | null, label: string, min: number, max: number): void {
  if (value === null) return;
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function parseExportGraph(graphJson: string): ExportGraph {
  const parsed = JSON.parse(graphJson) as ExportGraph;
  if (!parsed || typeof parsed !== "object") throw new Error("export graph must be an object");
  return parsed;
}

function validateCompositionGraphVersion(graph: ExportGraph): string | null {
  if (graph.schema_version !== 4 && graph.schema_version !== 5) {
    return `canonical export requires composition graph schema v4 or v5 (received ${String(graph.schema_version)})`;
  }
  if (graph.schema_version !== 5) return null;

  for (const node of Array.isArray(graph.video) ? graph.video : []) {
    if (node.type !== "background") continue;
    const scale = node.foreground_scale;
    if (!isValidExportForegroundScale(scale)) {
      const nodeId = typeof node.id === "string" ? ` ${node.id}` : "";
      return `composition graph schema v5 background${nodeId} foreground_scale must be a finite number between ${EXPORT_FOREGROUND_SCALE_MIN} and ${EXPORT_FOREGROUND_SCALE_MAX}`;
    }
  }
  return null;
}

function sourceNodes(graph: ExportGraph): ExportSourceNode[] {
  return (Array.isArray(graph.video) ? graph.video : [])
    .filter((node) => node.type === "source")
    .map((node) => ({
      type: "source",
      id: typeof node.id === "string" ? node.id : undefined,
      path: typeof node.path === "string" ? node.path : "",
      pts_offset_ms: finiteNumber(node.pts_offset_ms) ?? undefined,
      duration_ms: finiteNumber(node.duration_ms) ?? undefined,
      source_width: finiteNumber(node.source_width) ?? undefined,
      source_height: finiteNumber(node.source_height) ?? undefined,
      source_fps: finiteNumber(node.source_fps) ?? undefined,
      source_time_map: node.source_time_map,
    }));
}

export function firstSourcePath(graphJson: string): string {
  const source = sourceNodes(parseExportGraph(graphJson)).find((node) => node.path);
  if (!source?.path) throw new Error("export graph has no source video");
  return source.path;
}

export function unsupportedExportGraphNodes(graphJson: string): string[] {
  const graph = parseExportGraph(graphJson);
  return unsupportedGraphNodes(graph);
}

export function analyzeExportPlan(graphJson: string, output: ExportOutput): ExportPlan {
  let graph: ExportGraph;
  try {
    graph = parseExportGraph(graphJson);
  } catch (error) {
    return unsupportedPlan(output, null, errorMessage(error));
  }

  try {
    validateExportOutput(output);
  } catch (error) {
    return unsupportedPlan(output, graph, errorMessage(error));
  }

  const sources = sourceNodes(graph);
  const versionError = validateCompositionGraphVersion(graph);
  if (versionError) {
    return unsupportedPlan(output, graph, versionError);
  }
  if (sources.length === 0 || sources.some((source) => !source.path)) {
    return unsupportedPlan(output, graph, "export graph has no source video");
  }

  const unsupportedNodes = unsupportedGraphNodes(graph);
  if (unsupportedNodes.length > 0) {
    return unsupportedPlan(
      output,
      graph,
      `export compositor does not yet support graph nodes: ${unsupportedNodes.join(", ")}`,
      "composited",
      unsupportedNodes,
    );
  }

  const source = sources[0];
  if (!source?.path) {
    return unsupportedPlan(output, graph, "export graph has no source video");
  }

  const encoderOptions = normalizeExportEncoderOptions(output);
  const base = { output, graph, source, encoderOptions };
  return compositedPlan(base);
}

function unsupportedGraphNodes(graph: ExportGraph): string[] {
  const unsupported = new Set<string>();
  for (const node of Array.isArray(graph.video) ? graph.video : []) {
    const type = String(node.type ?? "unknown-video");
    if (!SUPPORTED_COMPOSITOR_VIDEO_NODES.has(type)) unsupported.add(type);
  }
  for (const node of Array.isArray(graph.audio) ? graph.audio : []) {
    if (node.type !== "sound") unsupported.add(`audio:${String(node.type ?? "unknown")}`);
  }
  return [...unsupported].sort();
}

function compositedPlan(
  base: RunnableExportPlanBase,
): CompositedExportPlan | UnsupportedExportPlan {
  const durationMs = finiteNumber(base.graph.duration_ms);
  if (!durationMs) {
    return unsupportedPlan(
      base.output,
      base.graph,
      "canonical export requires graph duration_ms",
      "composited",
      ["duration_ms"],
    );
  }
  const size = compositedOutputSize(base.graph, base.output, base.source);
  const fps = clampFpsValue(base.output.fps ?? base.graph.output_fps);
  return {
    ...base,
    graph: {
      ...base.graph,
      output_width: size.width,
      output_height: size.height,
      output_fps: fps,
      duration_ms: Math.max(1, Math.round(durationMs)),
    },
    kind: "composited",
    outputWidth: size.width,
    outputHeight: size.height,
    fps,
    durationMs: Math.max(1, Math.round(durationMs)),
    frameCount: Math.max(1, Math.ceil((durationMs / 1000) * fps)),
    pixelFormat: "bgra",
  };
}

function compositedOutputSize(
  graph: ExportGraph,
  output: ExportOutput,
  source: ExportSourceNode,
): { width: number; height: number } {
  const outputSize = resolutionSize(output);
  if (outputSize) return outputSize;
  const graphWidth = finiteNumber(graph.output_width);
  const graphHeight = finiteNumber(graph.output_height);
  if (graphWidth && graphHeight && graphWidth > 0 && graphHeight > 0) {
    return {
      width: clampDimensionValue(graphWidth, 1920),
      height: clampDimensionValue(graphHeight, 1080),
    };
  }
  if (source.source_width && source.source_height) {
    return {
      width: clampDimensionValue(source.source_width, 1920),
      height: clampDimensionValue(source.source_height, 1080),
    };
  }
  return { width: 1920, height: 1080 };
}

function unsupportedPlan(
  output: ExportOutput,
  graph: ExportGraph | null,
  reason: string,
  requiredPlan?: "simple-concat" | "composited",
  unsupportedNodes?: string[],
): UnsupportedExportPlan {
  return {
    kind: "unsupported",
    output,
    graph,
    reason,
    requiredPlan,
    unsupportedNodes,
  };
}

export function ffmpegArgsForCanonicalExportPlan(
  plan: CompositedExportPlan,
  audioPlan: CanonicalExportAudioPlan,
  out: string,
): string[] {
  const format = enumValue(plan.output.format, FORMATS) ?? "mp4";
  const rawInput = [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    plan.pixelFormat,
    "-s",
    `${plan.outputWidth}x${plan.outputHeight}`,
    "-framerate",
    String(plan.fps),
    "-i",
    "pipe:0",
  ];
  const exactDuration = (plan.durationMs / 1_000).toFixed(6);
  if (format === "gif") {
    return [
      ...rawInput,
      "-filter_complex",
      "[0:v]split[gif_palette_source][gif_source];[gif_palette_source]palettegen=max_colors=256[gif_palette];[gif_source][gif_palette]paletteuse=dither=sierra2_4a[gif_video]",
      "-map",
      "[gif_video]",
      "-an",
      "-loop",
      "0",
      "-t",
      exactDuration,
      out,
    ];
  }
  if (audioPlan.kind === "invalid") {
    const reason = audioPlan.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
    throw new Error(reason || "canonical audio planning failed");
  }
  const args = [...rawInput, ...audioPlan.inputArgs];
  if (audioPlan.filterComplex) args.push("-filter_complex", audioPlan.filterComplex);
  args.push("-map", "0:v:0", ...audioPlan.mapArgs);
  if (format === "webm") args.push(...webmVideoArgs(plan.output, plan.encoderOptions));
  else args.push(...mp4VideoArgs(plan));
  args.push(...audioPlan.encoderArgs, ...audioPlan.outputArgs, out);
  return args;
}

function mp4VideoArgs(plan: CompositedExportPlan): string[] {
  const { encoderOptions, output } = plan;
  const capability = MP4_ENCODER_CAPABILITIES[encoderOptions.hwEncoder];
  if (!capability) {
    throw new Error(
      `encoder ${encoderOptions.hwEncoder} is not supported by the bundled MP4 delivery path`,
    );
  }
  const args = ["-c:v", capability.ffmpegName];
  switch (encoderOptions.hwEncoder) {
    case "libx264-software":
      args.push("-preset", encoderOptions.encoderPreset ?? "medium");
      args.push("-crf", String(crfValue(output, encoderOptions)));
      break;
    case "nvenc-h264":
      args.push(
        "-preset",
        encoderOptions.encoderPreset ?? "p4",
        "-rc",
        "vbr",
        "-cq",
        String(cqValue(output, encoderOptions)),
        ...hardwareBitrateArgs(plan, false),
      );
      break;
    case "video-toolbox-h264":
      args.push(
        "-prio_speed",
        encoderOptions.encoderPreset === "speed" ? "1" : "0",
        ...hardwareBitrateArgs(plan, true),
      );
      break;
    case "qsv-h264":
      args.push(
        "-preset",
        encoderOptions.encoderPreset ?? "medium",
        ...hardwareBitrateArgs(plan, true),
      );
      break;
    case "amf-h264":
      args.push(
        "-quality",
        encoderOptions.encoderPreset ?? "balanced",
        "-rc",
        "vbr_peak",
        ...hardwareBitrateArgs(plan, true),
      );
      break;
  }
  args.push(
    ...keyframeArgs(plan.fps, encoderOptions),
    "-fps_mode",
    "cfr",
    "-profile:v",
    MP4_DELIVERY_PROFILE.profile,
    "-pix_fmt",
    MP4_DELIVERY_PROFILE.pixelFormat,
    "-color_range",
    MP4_DELIVERY_PROFILE.colorRange,
    "-color_primaries",
    MP4_DELIVERY_PROFILE.colorPrimaries,
    "-color_trc",
    MP4_DELIVERY_PROFILE.colorTransfer,
    "-colorspace",
    MP4_DELIVERY_PROFILE.colorMatrix,
    "-movflags",
    "+faststart",
  );
  return args;
}

function webmVideoArgs(
  output: ExportOutput,
  encoderOptions: NormalizedExportEncoderOptions,
): string[] {
  return [
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    bitrateValue(output, encoderOptions),
    ...keyframeArgs(clampFpsValue(output.fps), encoderOptions),
  ];
}

export function hardwareTargetBitrateMbps(
  width: number,
  height: number,
  fps: number,
  quality: ExportQuality,
  explicitMbps: number | null = null,
): number {
  const coefficient = MP4_DELIVERY_PROFILE.hardwareBitrateCoefficient[quality];
  const calculated = explicitMbps ?? (width * height * fps * coefficient) / 1_000_000;
  return Math.max(
    MP4_DELIVERY_PROFILE.minHardwareBitrateMbps,
    Math.min(MP4_DELIVERY_PROFILE.maxHardwareBitrateMbps, calculated),
  );
}

function hardwareBitrateArgs(plan: CompositedExportPlan, allowExplicitBitrate: boolean): string[] {
  const target = hardwareTargetBitrateMbps(
    plan.outputWidth,
    plan.outputHeight,
    plan.fps,
    enumValue(plan.output.quality, QUALITIES) ?? "high",
    allowExplicitBitrate ? plan.encoderOptions.qualityValue : null,
  );
  return [
    "-b:v",
    bitrateArgument(target),
    "-maxrate",
    bitrateArgument(target * MP4_DELIVERY_PROFILE.maxrateMultiplier),
    "-bufsize",
    bitrateArgument(target * MP4_DELIVERY_PROFILE.bufferMultiplier),
  ];
}

function bitrateArgument(mbps: number): string {
  return `${Number(mbps.toFixed(2))}M`;
}

function bitrateValue(
  output: ExportOutput,
  encoderOptions: NormalizedExportEncoderOptions,
): string {
  const mbps =
    encoderOptions.qualityValue ??
    (output.quality === "high" ? 8 : output.quality === "med" ? 4 : 2);
  return `${Math.max(1, Math.round(mbps))}M`;
}

function crfValue(output: ExportOutput, encoderOptions: NormalizedExportEncoderOptions): number {
  if (encoderOptions.qualityValue !== null) return Math.round(encoderOptions.qualityValue);
  return MP4_DELIVERY_PROFILE.crf[enumValue(output.quality, QUALITIES) ?? "high"];
}

function cqValue(output: ExportOutput, encoderOptions: NormalizedExportEncoderOptions): number {
  if (encoderOptions.qualityValue !== null) return Math.round(encoderOptions.qualityValue);
  return output.quality === "high" ? 19 : output.quality === "med" ? 24 : 30;
}

function keyframeArgs(fps: number, encoderOptions: NormalizedExportEncoderOptions): string[] {
  const keyframeIntervalSec =
    encoderOptions.keyframeIntervalSec ?? MP4_DELIVERY_PROFILE.defaultKeyframeIntervalSec;
  const interval = Math.max(1, Math.round(clampFpsValue(fps) * keyframeIntervalSec));
  return ["-g", String(interval)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { exportFfmpegPath, exportFfprobePath } from "../export-binaries";
import {
  EXPORT_LOUDNESS_TARGET,
  type ExportLoudnessMeasurement,
  parseExportLoudnessMeasurement,
} from "./export-audio-planning";
import { type AiVoiceXmpMetadata, readAdobeXmpMetadata } from "./export-xmp";

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export interface ExportArtifactExpectation {
  format: "mp4" | "webm" | "gif";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  expectAudio: boolean;
  expectXmp?: boolean;
}

export interface VerifiedExportArtifact {
  fileSize: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  audioStreams: number;
  videoCodec: string | null;
  videoProfile: string | null;
  pixelFormat: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorMatrix: string | null;
  colorRange: string | null;
  frameRateMode: "cfr" | "vfr" | "unknown";
  videoBitrateKbps: number | null;
  audioCodec: string | null;
  audioProfile: string | null;
  audioSampleRateHz: number | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  audioBitrateKbps: number | null;
  faststart: boolean | null;
  fullDecodePassed: boolean;
  loudness: ExportLoudnessMeasurement | null;
  xmp: AiVoiceXmpMetadata | null;
}

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 ? top / bottom : 0;
}

function durationMs(document: FfprobeDocument, video: FfprobeStream): number {
  const seconds = Number(document.format?.duration ?? video.duration);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : 0;
}

function bitrateKbps(value: string | undefined): number | null {
  const bitsPerSecond = Number(value);
  return Number.isFinite(bitsPerSecond) && bitsPerSecond >= 0 ? bitsPerSecond / 1_000 : null;
}

function requiredValue(actual: string | undefined, expected: string, label: string): void {
  if (actual?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Export ${label} is ${actual ?? "unknown"}; expected ${expected}.`);
  }
}

function frameRateMode(video: FfprobeStream): "cfr" | "vfr" | "unknown" {
  const average = frameRate(video.avg_frame_rate);
  const nominal = frameRate(video.r_frame_rate);
  if (average <= 0 || nominal <= 0) return "unknown";
  return Math.abs(average - nominal) <= 0.02 ? "cfr" : "vfr";
}

function validateMp4VideoContract(video: FfprobeStream): void {
  requiredValue(video.codec_name, "h264", "video codec");
  requiredValue(video.profile, "High", "H.264 profile");
  requiredValue(video.pix_fmt, "yuv420p", "pixel format");
  requiredValue(video.color_primaries, "bt709", "color primaries");
  requiredValue(video.color_transfer, "bt709", "color transfer");
  requiredValue(video.color_space, "bt709", "color matrix");
  requiredValue(video.color_range, "tv", "color range");
  if (frameRateMode(video) !== "cfr") {
    throw new Error("Export video stream is not constant frame rate.");
  }
}

function validateMp4AudioContract(audio: FfprobeStream): void {
  requiredValue(audio.codec_name, "aac", "audio codec");
  requiredValue(audio.profile, "LC", "AAC profile");
  if (Number(audio.sample_rate) !== 48_000) {
    throw new Error(
      `Export audio sample rate is ${audio.sample_rate ?? "unknown"}; expected 48000.`,
    );
  }
  if (audio.channels !== 2 || audio.channel_layout?.toLowerCase() !== "stereo") {
    throw new Error(
      `Export audio layout is ${audio.channel_layout ?? "unknown"}/${audio.channels ?? 0} channels; expected stereo/2 channels.`,
    );
  }
}

export function validateExportArtifactProbe(
  document: FfprobeDocument,
  expected: ExportArtifactExpectation,
  fileSize: number,
): VerifiedExportArtifact {
  if (fileSize <= 0) throw new Error("Export artifact is empty.");
  const streams = document.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Export artifact has no video stream.");
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `Export dimensions are ${width}x${height}; expected ${expected.width}x${expected.height}.`,
    );
  }
  const fps = frameRate(video.avg_frame_rate || video.r_frame_rate);
  // GIF stores frame delays in centiseconds, so an otherwise correct CFR
  // animation can probe slightly below its requested rate (for example,
  // 48 frames at 30 fps reports 179/6). Video containers remain strict.
  const fpsTolerance = expected.format === "gif" ? Math.max(0.25, expected.fps * 0.01) : 0.02;
  if (!Number.isFinite(fps) || Math.abs(fps - expected.fps) > fpsTolerance) {
    throw new Error(`Export FPS is ${fps || "unknown"}; expected ${expected.fps}.`);
  }
  const actualDurationMs = durationMs(document, video);
  const durationToleranceMs = Math.max(1_000 / expected.fps, 50);
  if (Math.abs(actualDurationMs - expected.durationMs) > durationToleranceMs) {
    throw new Error(
      `Export duration is ${Math.round(actualDurationMs)}ms; expected ${expected.durationMs}ms (±${Math.round(durationToleranceMs)}ms).`,
    );
  }
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio").length;
  if (expected.expectAudio && audioStreams === 0) {
    throw new Error("Export artifact is missing the expected audio stream.");
  }
  if (!expected.expectAudio && audioStreams > 0) {
    throw new Error(`${expected.format.toUpperCase()} export unexpectedly contains audio.`);
  }
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (expected.format === "mp4") {
    validateMp4VideoContract(video);
    if (expected.expectAudio) {
      if (audioStreams !== 1 || !audio) {
        throw new Error(`MP4 export contains ${audioStreams} audio streams; expected exactly one.`);
      }
      validateMp4AudioContract(audio);
    }
  }
  return {
    fileSize,
    width,
    height,
    fps,
    durationMs: actualDurationMs,
    audioStreams,
    videoCodec: video.codec_name ?? null,
    videoProfile: video.profile ?? null,
    pixelFormat: video.pix_fmt ?? null,
    colorPrimaries: video.color_primaries ?? null,
    colorTransfer: video.color_transfer ?? null,
    colorMatrix: video.color_space ?? null,
    colorRange: video.color_range ?? null,
    frameRateMode: frameRateMode(video),
    videoBitrateKbps: bitrateKbps(video.bit_rate),
    audioCodec: audio?.codec_name ?? null,
    audioProfile: audio?.profile ?? null,
    audioSampleRateHz: audio?.sample_rate ? Number(audio.sample_rate) : null,
    audioChannels: audio?.channels ?? null,
    audioChannelLayout: audio?.channel_layout ?? null,
    audioBitrateKbps: bitrateKbps(audio?.bit_rate),
    faststart: null,
    fullDecodePassed: false,
    loudness: null,
    xmp: null,
  };
}

async function ffprobeDocument(filePath: string): Promise<FfprobeDocument> {
  const { stdout } = await execFileAsync(
    exportFfprobePath(),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,avg_frame_rate,r_frame_rate,duration,bit_rate,sample_rate,channels,channel_layout:format=duration",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as FfprobeDocument;
}

export function buildArtifactLoudnessAnalysisArgs(filePath: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-v",
    "info",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-af",
    `loudnorm=I=${EXPORT_LOUDNESS_TARGET.integratedLufs}:TP=${EXPORT_LOUDNESS_TARGET.truePeakDbtp}:LRA=${EXPORT_LOUDNESS_TARGET.loudnessRangeLu}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

export function validateExportLoudness(
  measurement: ExportLoudnessMeasurement,
): ExportLoudnessMeasurement {
  if (
    Math.abs(measurement.integratedLufs - EXPORT_LOUDNESS_TARGET.integratedLufs) >
    EXPORT_LOUDNESS_TARGET.integratedToleranceLu
  ) {
    throw new Error(
      `Export integrated loudness is ${measurement.integratedLufs} LUFS; expected ${EXPORT_LOUDNESS_TARGET.integratedLufs} ±${EXPORT_LOUDNESS_TARGET.integratedToleranceLu} LU.`,
    );
  }
  if (measurement.truePeakDbtp > EXPORT_LOUDNESS_TARGET.truePeakDbtp) {
    throw new Error(
      `Export true peak is ${measurement.truePeakDbtp} dBTP; expected no more than ${EXPORT_LOUDNESS_TARGET.truePeakDbtp} dBTP.`,
    );
  }
  return measurement;
}

async function verifyMp4Faststart(filePath: string, fileSize: number): Promise<boolean> {
  const file = await fs.open(filePath, "r");
  try {
    let offset = 0;
    let moovOffset: number | null = null;
    let mdatOffset: number | null = null;
    const header = Buffer.alloc(16);
    while (offset + 8 <= fileSize) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      const atomType = header.toString("ascii", 4, 8);
      const size32 = header.readUInt32BE(0);
      const atomSize =
        size32 === 1 && bytesRead >= 16
          ? Number(header.readBigUInt64BE(8))
          : size32 || fileSize - offset;
      if (!Number.isSafeInteger(atomSize) || atomSize < (size32 === 1 ? 16 : 8)) {
        throw new Error(`MP4 contains an invalid ${atomType || "unknown"} atom size.`);
      }
      if (atomType === "moov") moovOffset = offset;
      if (atomType === "mdat") mdatOffset = offset;
      if (moovOffset !== null && mdatOffset !== null) break;
      offset += atomSize;
    }
    if (moovOffset === null || mdatOffset === null) {
      throw new Error("MP4 is missing a top-level moov or mdat atom.");
    }
    if (moovOffset > mdatOffset) {
      throw new Error("MP4 moov atom appears after media data; faststart was not applied.");
    }
    return true;
  } finally {
    await file.close();
  }
}

export async function sourceHasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    exportFfprobePath(),
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { streams?: unknown[] };
  return (parsed.streams?.length ?? 0) > 0;
}

export async function verifyExportArtifact(
  filePath: string,
  expected: ExportArtifactExpectation,
): Promise<VerifiedExportArtifact> {
  const stat = await fs.stat(filePath);
  const probe = validateExportArtifactProbe(await ffprobeDocument(filePath), expected, stat.size);
  await execFileAsync(
    exportFfmpegPath(),
    ["-v", "error", "-i", filePath, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const faststart =
    expected.format === "mp4" ? await verifyMp4Faststart(filePath, stat.size) : null;
  let loudness: ExportLoudnessMeasurement | null = null;
  if (expected.format === "mp4" && expected.expectAudio) {
    const { stderr } = await execFileAsync(
      exportFfmpegPath(),
      buildArtifactLoudnessAnalysisArgs(filePath),
      { maxBuffer: 4 * 1024 * 1024 },
    );
    loudness = validateExportLoudness(parseExportLoudnessMeasurement(stderr));
  }
  const xmp = expected.format === "mp4" ? await readAdobeXmpMetadata(filePath) : null;
  if (expected.expectXmp && !xmp) {
    throw new Error("MP4 export is missing the requested AI-generated voice XMP metadata.");
  }
  return { ...probe, faststart, fullDecodePassed: true, loudness, xmp };
}

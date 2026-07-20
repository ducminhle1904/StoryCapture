import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import type { RecordingRational } from "@storycapture/shared-types/recording-v2";

import { ffmpegExecutablePath } from "./export-binaries";

export const RECORDING_FIXTURE_WIDTH = 1920;
export const RECORDING_FIXTURE_HEIGHT = 1080;
export const RECORDING_FIXTURE_FPS = { numerator: 60, denominator: 1 } as const;
export const RECORDING_FIXTURE_DEFAULT_FRAMES = 300;

export interface FixtureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FixturePoint {
  x: number;
  y: number;
}

export interface RecordingVerifierFixtureManifest {
  version: 1;
  kind: "motion" | "static";
  width: typeof RECORDING_FIXTURE_WIDTH;
  height: typeof RECORDING_FIXTURE_HEIGHT;
  fps: RecordingRational;
  default_frame_count: number;
  text_sizes_px: readonly [12, 16, 24, 42];
  text_edge_rois: FixtureRect[];
  one_pixel_edge_roi: FixtureRect;
  checkerboard_roi: FixtureRect;
  overlay_roi: FixtureRect;
  chroma_samples: FixturePoint[];
  motion_roi: FixtureRect;
  ordinal_roi: FixtureRect | null;
  ordinal_bits: number;
}

export interface RecordingVerifierFixtureSample {
  source_sequence: number;
  monotonic_timestamp_us: number;
  frame: Buffer;
}

const TEXT_SIZES = [12, 16, 24, 42] as const;
const TEXT_ROIS: FixtureRect[] = [
  { x: 48, y: 64, width: 400, height: 52 },
  { x: 48, y: 136, width: 400, height: 56 },
  { x: 48, y: 216, width: 400, height: 64 },
  { x: 48, y: 304, width: 400, height: 82 },
];
const ONE_PIXEL_EDGE_ROI = { x: 816, y: 64, width: 256, height: 256 };
const CHECKERBOARD_ROI = { x: 512, y: 64, width: 256, height: 256 };
const OVERLAY_ROI = { x: 512, y: 504, width: 224, height: 112 };
const MOTION_ROI = { x: 800, y: 472, width: 1072, height: 424 };
const ORDINAL_ROI = { x: 48, y: 976, width: 624, height: 48 };
const CHROMA_SAMPLES = [
  { x: 112, y: 568 },
  { x: 240, y: 568 },
  { x: 368, y: 568 },
  { x: 112, y: 696 },
  { x: 240, y: 696 },
  { x: 368, y: 696 },
];

const GLYPHS: Record<string, readonly string[]> = {
  "1": ["01100", "11100", "01100", "01100", "01100", "01100", "11111"],
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
};

function fillRect(
  frame: Buffer,
  rect: FixtureRect,
  red: number,
  green: number,
  blue: number,
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const rowStart = (y * RECORDING_FIXTURE_WIDTH + rect.x) * 4;
    for (let x = 0; x < rect.width; x += 1) {
      const offset = rowStart + x * 4;
      frame[offset] = blue;
      frame[offset + 1] = green;
      frame[offset + 2] = red;
      frame[offset + 3] = 255;
    }
  }
}

function drawBitmapText(frame: Buffer, text: string, x: number, y: number, fontSize: number): void {
  const glyphWidth = Math.ceil((fontSize * 5) / 7);
  const spacing = Math.max(1, Math.ceil(fontSize / 7));
  let cursorX = x;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (!glyph) continue;
    for (let row = 0; row < 7; row += 1) {
      const top = y + Math.floor((row * fontSize) / 7);
      const bottom = y + Math.floor(((row + 1) * fontSize) / 7);
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row]?.[column] !== "1") continue;
        const left = cursorX + Math.floor((column * glyphWidth) / 5);
        const right = cursorX + Math.floor(((column + 1) * glyphWidth) / 5);
        fillRect(
          frame,
          { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
          245,
          245,
          245,
        );
      }
    }
    cursorX += glyphWidth + spacing;
  }
}

function drawCheckerboard(frame: Buffer): void {
  const cell = 4;
  for (let y = 0; y < CHECKERBOARD_ROI.height; y += cell) {
    for (let x = 0; x < CHECKERBOARD_ROI.width; x += cell) {
      const bright = (x / cell + y / cell) % 2 === 0;
      fillRect(
        frame,
        {
          x: CHECKERBOARD_ROI.x + x,
          y: CHECKERBOARD_ROI.y + y,
          width: cell,
          height: cell,
        },
        bright ? 255 : 0,
        bright ? 255 : 0,
        bright ? 255 : 0,
      );
    }
  }
}

function drawOnePixelEdges(frame: Buffer): void {
  fillRect(frame, ONE_PIXEL_EDGE_ROI, 18, 18, 18);
  for (let x = 0; x < ONE_PIXEL_EDGE_ROI.width; x += 8) {
    fillRect(
      frame,
      { x: ONE_PIXEL_EDGE_ROI.x + x, y: ONE_PIXEL_EDGE_ROI.y, width: 1, height: 256 },
      255,
      255,
      255,
    );
  }
  for (let y = 0; y < ONE_PIXEL_EDGE_ROI.height; y += 16) {
    fillRect(
      frame,
      { x: ONE_PIXEL_EDGE_ROI.x, y: ONE_PIXEL_EDGE_ROI.y + y, width: 256, height: 1 },
      255,
      255,
      255,
    );
  }
}

function drawChromaSwatches(frame: Buffer): void {
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
  ] as const;
  for (let index = 0; index < colors.length; index += 1) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const [red, green, blue] = colors[index];
    fillRect(
      frame,
      { x: 48 + column * 128, y: 504 + row * 128, width: 128, height: 128 },
      red,
      green,
      blue,
    );
  }
}

function drawOrdinal(frame: Buffer, ordinal: number): void {
  fillRect(frame, ORDINAL_ROI, 12, 12, 12);
  for (let bit = 0; bit < 24; bit += 1) {
    const enabled = (ordinal & (2 ** bit)) !== 0;
    fillRect(
      frame,
      { x: ORDINAL_ROI.x + bit * 26 + 3, y: ORDINAL_ROI.y + 4, width: 20, height: 40 },
      enabled ? 255 : 0,
      enabled ? 255 : 0,
      enabled ? 255 : 0,
    );
  }
}

function renderFrame(renderIndex: number, includeOrdinal: boolean): Buffer {
  const frame = Buffer.alloc(RECORDING_FIXTURE_WIDTH * RECORDING_FIXTURE_HEIGHT * 4);
  fillRect(
    frame,
    { x: 0, y: 0, width: RECORDING_FIXTURE_WIDTH, height: RECORDING_FIXTURE_HEIGHT },
    24,
    28,
    36,
  );
  for (let index = 0; index < TEXT_SIZES.length; index += 1) {
    const size = TEXT_SIZES[index];
    drawBitmapText(frame, `${size}PX`, TEXT_ROIS[index].x + 8, TEXT_ROIS[index].y + 8, size);
  }
  drawCheckerboard(frame);
  drawOnePixelEdges(frame);
  drawChromaSwatches(frame);
  fillRect(frame, OVERLAY_ROI, 255, 32, 192);
  fillRect(
    frame,
    {
      x: MOTION_ROI.x + ((renderIndex * 11) % (MOTION_ROI.width - 64)),
      y: MOTION_ROI.y + ((renderIndex * 7) % (MOTION_ROI.height - 64)),
      width: 64,
      height: 64,
    },
    48,
    224,
    255,
  );
  if (includeOrdinal) drawOrdinal(frame, renderIndex);
  return frame;
}

export function recordingVerifierFixtureManifest(
  kind: "motion" | "static" = "motion",
): RecordingVerifierFixtureManifest {
  return {
    version: 1,
    kind,
    width: RECORDING_FIXTURE_WIDTH,
    height: RECORDING_FIXTURE_HEIGHT,
    fps: { ...RECORDING_FIXTURE_FPS },
    default_frame_count: RECORDING_FIXTURE_DEFAULT_FRAMES,
    text_sizes_px: TEXT_SIZES,
    text_edge_rois: TEXT_ROIS.map((roi) => ({ ...roi })),
    one_pixel_edge_roi: { ...ONE_PIXEL_EDGE_ROI },
    checkerboard_roi: { ...CHECKERBOARD_ROI },
    overlay_roi: { ...OVERLAY_ROI },
    chroma_samples: CHROMA_SAMPLES.map((sample) => ({ ...sample })),
    motion_roi: { ...MOTION_ROI },
    ordinal_roi: kind === "motion" ? { ...ORDINAL_ROI } : null,
    ordinal_bits: kind === "motion" ? 24 : 0,
  };
}

export function createRecordingVerifierFixtureSample(
  frameIndex: number,
  kind: "motion" | "static" = "motion",
): RecordingVerifierFixtureSample {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    throw new Error(
      `Fixture frame index must be a non-negative safe integer; received ${frameIndex}.`,
    );
  }
  return {
    source_sequence: frameIndex + 1,
    monotonic_timestamp_us: Math.floor((frameIndex * 1_000_000) / 60),
    frame: renderFrame(kind === "static" ? 0 : frameIndex, kind === "motion"),
  };
}

export function decodeFixtureOrdinal(frame: Buffer): number {
  if (frame.byteLength !== RECORDING_FIXTURE_WIDTH * RECORDING_FIXTURE_HEIGHT * 4) {
    throw new Error("Fixture ordinal decoder requires a 1920x1080 BGRA frame.");
  }
  let ordinal = 0;
  for (let bit = 0; bit < 24; bit += 1) {
    const x = ORDINAL_ROI.x + bit * 26 + 13;
    const y = ORDINAL_ROI.y + 24;
    const offset = (y * RECORDING_FIXTURE_WIDTH + x) * 4;
    const average = (frame[offset] + frame[offset + 1] + frame[offset + 2]) / 3;
    if (average >= 128) ordinal += 2 ** bit;
  }
  return ordinal;
}

export async function generateRecordingVerifierFixture(
  outputPath: string,
  options: { kind?: "motion" | "static"; frameCount?: number } = {},
): Promise<void> {
  const frameCount = options.frameCount ?? RECORDING_FIXTURE_DEFAULT_FRAMES;
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new Error(`Fixture frame count must be a positive safe integer; received ${frameCount}.`);
  }
  if (path.extname(outputPath).toLowerCase() !== ".mkv") {
    throw new Error("Deterministic recording fixtures must use the .mkv container.");
  }
  const child = spawn(
    ffmpegExecutablePath(),
    [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-video_size",
      `${RECORDING_FIXTURE_WIDTH}x${RECORDING_FIXTURE_HEIGHT}`,
      "-framerate",
      "60",
      "-i",
      "pipe:0",
      "-frames:v",
      String(frameCount),
      "-an",
      "-c:v",
      "ffv1",
      "-level",
      "3",
      "-pix_fmt",
      "bgra",
      outputPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
    if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Fixture encoder exited with code ${String(code)}: ${stderr}`));
    });
  });
  if (!child.stdin) {
    child.kill("SIGKILL");
    await done.catch(() => undefined);
    throw new Error("Fixture encoder stdin is unavailable.");
  }
  child.stdin.on("error", () => undefined);
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const sample = createRecordingVerifierFixtureSample(frameIndex, options.kind);
      if (!child.stdin.write(sample.frame)) {
        await Promise.race([
          once(child.stdin, "drain"),
          done.then(() => {
            throw new Error("Fixture encoder closed before accepting every source frame.");
          }),
        ]);
      }
    }
    child.stdin.end();
    await done;
  } catch (error) {
    child.stdin.destroy();
    child.kill("SIGKILL");
    await done.catch(() => undefined);
    throw error;
  }
}

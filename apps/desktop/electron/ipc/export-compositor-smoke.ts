import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { app, type BrowserWindow } from "electron";
import ffmpegPath from "ffmpeg-static";

import { createExportCompositorHost } from "./export-compositor-host";
import { type ExportPipelineSmokeEvidence, runExportPipelineSmoke } from "./export-e2e-smoke";

const OUTPUT_WIDTH = 320;
const OUTPUT_HEIGHT = 180;
const DURATION_MS = 1_000;

interface MainRendererEvidence {
  url: string;
  readyState: string;
  rootChildren: number;
}

interface CompositorEvidence {
  frameBytes: number;
  visiblePixels: number;
  textChangedPixels: number;
  bundledFontFamilies: string[];
  loadFailures: string[];
}

interface SmokeSuccess {
  ok: true;
  mainRenderer: MainRendererEvidence;
  compositor: CompositorEvidence;
  pipeline: ExportPipelineSmokeEvidence;
}

interface SmokeFailure {
  ok: false;
  error: Record<string, unknown>;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function serializedError(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object" && "toJSON" in error) {
    const toJSON = (error as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return toJSON.call(error) as Record<string, unknown>;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

async function waitForMainRenderer(win: BrowserWindow): Promise<MainRendererEvidence> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const evidence = (await win.webContents.executeJavaScript(
        `({
          url: window.location.href,
          readyState: document.readyState,
          rootChildren: document.getElementById("root")?.childElementCount ?? 0,
        })`,
        true,
      )) as MainRendererEvidence;
      if (
        evidence.url.startsWith("file:") &&
        evidence.readyState === "complete" &&
        evidence.rootChildren > 0
      ) {
        return evidence;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Main renderer stayed blank or unavailable: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "no render root")
    }`,
  );
}

async function createVideoFixture(outputPath: string): Promise<void> {
  const binary = ffmpegPath?.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=black:size=160x90:rate=2",
        "-t",
        "1",
        "-c:v",
        "libaom-av1",
        "-cpu-used",
        "8",
        "-crf",
        "40",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`smoke fixture ffmpeg exited with ${code}: ${stderr}`));
    });
  });
}

function sourceNode(videoPath: string): Record<string, unknown> {
  return {
    type: "source",
    id: "smoke-source",
    clip_id: "smoke-clip",
    path: videoPath,
    pts_offset_ms: 0,
    timeline_start_ms: 0,
    duration_ms: DURATION_MS,
    source_width: 160,
    source_height: 90,
  };
}

const backgroundNode = {
  type: "background",
  id: "smoke-background",
  kind: { kind: "image", asset_id: "cosmic:1", path: null },
  radius_px: 8,
  shadow: null,
  padding_px: 24,
};

const textNode = {
  type: "text-overlay",
  id: "smoke-text",
  boxes: [
    {
      clip_id: "smoke-text-box",
      t_start_ms: 0,
      t_end_ms: DURATION_MS,
      text: "Artifact font",
      pos: { x: 0.5, y: 0.5 },
      fallback_pos: { x: 0.5, y: 0.5 },
      anchor: { kind: "screen", pos: { x: 0.5, y: 0.5 } },
      source_binding: null,
      font: { kind: "bundled", family: "Geist Variable", weight: 700, style: "normal" },
      size_pt: 24,
      color: { r: 255, g: 255, b: 255, a: 255 },
      align: "center",
      max_width_pct: 0.8,
      line_height: 1.2,
      letter_spacing_px: 0,
      text_shadow: null,
      box_style: null,
      anim_in: "none",
      anim_out: "none",
      anim_duration_ms: 0,
    },
  ],
};

function graph(videoPath: string, withText: boolean) {
  return {
    schema_version: 4,
    output_width: OUTPUT_WIDTH,
    output_height: OUTPUT_HEIGHT,
    output_fps: 30,
    duration_ms: DURATION_MS,
    video: [sourceNode(videoPath), backgroundNode, ...(withText ? [textNode] : [])],
    audio: [],
  };
}

async function renderSmokeFrame(
  videoPath: string,
  withText: boolean,
): Promise<{
  frame: Buffer;
  fonts: Array<{ family: string; status: string }>;
  loadFailures: string[];
}> {
  const host = createExportCompositorHost({
    graph: graph(videoPath, withText),
    outputWidth: OUTPUT_WIDTH,
    outputHeight: OUTPUT_HEIGHT,
    fps: 30,
    durationMs: DURATION_MS,
  });
  const loadFailures: string[] = [];
  host.window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    loadFailures.push(`${isMainFrame ? "main" : "subframe"}:${code}:${description}:${url}`);
  });
  try {
    await host.start();
    const fonts = (await host.window.webContents.executeJavaScript(
      "Array.from(document.fonts, (face) => ({ family: face.family, status: face.status }))",
      true,
    )) as Array<{ family: string; status: string }>;
    return { frame: await host.renderFrame(250), fonts, loadFailures };
  } finally {
    await host.dispose();
  }
}

function frameEvidence(
  withoutText: Buffer,
  withText: Buffer,
): Pick<CompositorEvidence, "frameBytes" | "visiblePixels" | "textChangedPixels"> {
  if (withoutText.byteLength !== withText.byteLength) {
    throw new Error("Smoke compositor frame sizes differ");
  }
  let visiblePixels = 0;
  let textChangedPixels = 0;
  for (let index = 0; index < withText.byteLength; index += 4) {
    if (withText[index] || withText[index + 1] || withText[index + 2]) visiblePixels += 1;
    if (
      withText[index] !== withoutText[index] ||
      withText[index + 1] !== withoutText[index + 1] ||
      withText[index + 2] !== withoutText[index + 2]
    ) {
      textChangedPixels += 1;
    }
  }
  return { frameBytes: withText.byteLength, visiblePixels, textChangedPixels };
}

async function runSmoke(
  mainWindow: BrowserWindow,
  mainLoadFailures: readonly string[],
): Promise<SmokeSuccess> {
  const mainRenderer = await waitForMainRenderer(mainWindow);
  if (mainLoadFailures.length > 0) {
    throw new Error(`Main renderer load failed: ${mainLoadFailures.join("; ")}`);
  }
  const exportsDir = path.join(app.getPath("userData"), "exports");
  const videoPath = path.join(exportsDir, "export-compositor-artifact-smoke.mp4");
  await createVideoFixture(videoPath);
  const [base, text] = await Promise.all([
    renderSmokeFrame(videoPath, false),
    renderSmokeFrame(videoPath, true),
  ]);
  const loadFailures = [...base.loadFailures, ...text.loadFailures];
  if (loadFailures.length > 0) {
    throw new Error(`Export compositor load failed: ${loadFailures.join("; ")}`);
  }
  const pixels = frameEvidence(base.frame, text.frame);
  if (pixels.visiblePixels <= 1_000) throw new Error("Bundled background did not render");
  if (pixels.textChangedPixels <= 100) throw new Error("Bundled font text did not render");
  const loadedFontFamilies = text.fonts
    .filter((font) => font.status === "loaded")
    .map((font) => font.family);
  if (!loadedFontFamilies.includes("Geist Variable")) {
    throw new Error("Bundled Geist Variable font was not loaded");
  }
  const pipeline = await runExportPipelineSmoke(path.join(exportsDir, "pipeline-smoke"));
  return {
    ok: true,
    mainRenderer,
    compositor: {
      ...pixels,
      bundledFontFamilies: loadedFontFamilies,
      loadFailures,
    },
    pipeline,
  };
}

export async function runExportCompositorArtifactSmoke(
  mainWindow: BrowserWindow,
  mainLoadFailures: readonly string[],
  resultPath: string,
): Promise<boolean> {
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(
    resultPath,
    `${JSON.stringify({ ok: false, error: { message: "smoke-started" } }, null, 2)}\n`,
  );
  let result: SmokeSuccess | SmokeFailure;
  try {
    result = await runSmoke(mainWindow, mainLoadFailures);
  } catch (error) {
    result = { ok: false, error: serializedError(error) };
  }
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result.ok;
}

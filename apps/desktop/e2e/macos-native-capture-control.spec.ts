import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = path.resolve(import.meta.dirname, "..");

interface ControlConfig {
  runId: string;
  title: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  resultPath: string;
  tracePath: string | null;
}

function controlConfig(): ControlConfig {
  const raw = process.env.STORYCAPTURE_NATIVE_SPIKE_CONTROL;
  if (!raw) throw new Error("STORYCAPTURE_NATIVE_SPIKE_CONTROL is required");
  const parsed = JSON.parse(raw) as Partial<ControlConfig>;
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  const fps = Number(parsed.fps);
  const durationMs = Number(parsed.durationMs);
  const resultPath = path.resolve(String(parsed.resultPath ?? ""));
  const tracePath = parsed.tracePath == null ? null : path.resolve(String(parsed.tracePath));
  const allowedRoot = path.join(os.tmpdir(), "storycapture-native-spikes") + path.sep;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(String(parsed.runId ?? "")) ||
    !parsed.title ||
    !resultPath.startsWith(allowedRoot) ||
    (tracePath !== null && !tracePath.startsWith(allowedRoot)) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(fps) ||
    !Number.isInteger(durationMs)
  ) {
    throw new Error("native spike Electron control config is invalid");
  }
  return {
    runId: String(parsed.runId),
    title: String(parsed.title),
    width,
    height,
    fps,
    durationMs,
    resultPath,
    tracePath,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

test("measures the production Electron external-window control", async () => {
  test.skip(
    !process.env.STORYCAPTURE_NATIVE_SPIKE_CONTROL,
    "This control is invoked by the native spike harness",
  );
  const config = controlConfig();
  test.setTimeout(config.durationMs + 120_000);
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-native-control-"));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-native-user-data-"));
  await fs.mkdir(path.dirname(config.resultPath), { recursive: true });
  if (config.tracePath) {
    const trace = (await fs.readFile(config.tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace).toEqual([
      expect.objectContaining({
        schema_version: 2,
        event: "recording.backend.spike_started",
        backend_id: "macos_screencapturekit",
      }),
    ]);
    expect(trace[0]).not.toHaveProperty("session_id");
  }
  const app = await electron.launch({
    args: [desktopDir, `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      STORYCAPTURE_CAPTURE_BACKEND_MODE: "legacy",
      STORYCAPTURE_RECORDING_AV_MODE: "unified",
      STORYCAPTURE_RECORDING_BUNDLE_MODE: "required",
      STORYCAPTURE_RECORDING_OUTCOME_MODE: "shadow",
      STORYCAPTURE_RECORDING_READINESS_MODE: "enforce",
    },
  });

  let payload: Record<string, unknown> = {
    status: "failed",
    failure_reason: "control_not_started",
    run_id: config.runId,
    requested_size: { width: config.width, height: config.height },
    requested_fps: config.fps,
    duration_ms: config.durationMs,
  };
  try {
    await expect
      .poll(() => app.windows().some((window) => window.url().startsWith("http://127.0.0.1:1420")))
      .toBe(true);
    const renderer = app
      .windows()
      .find((window) => window.url().startsWith("http://127.0.0.1:1420"));
    if (!renderer) throw new Error("StoryCapture renderer window did not open");
    await renderer.waitForFunction(() =>
      Boolean((window as never as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
    );
    const resolveSource = () =>
      app.evaluate(async ({ desktopCapturer }, title) => {
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 320, height: 180 },
        });
        const match = sources.find((candidate) => candidate.name === title);
        return match
          ? { id: match.id, name: match.name, thumbnailEmpty: match.thumbnail.isEmpty() }
          : null;
      }, config.title);
    await expect.poll(resolveSource, { timeout: 15_000 }).not.toBeNull();
    const source = await resolveSource();
    if (!source) throw new Error("exact Swift fixture window was not found");
    if (source.thumbnailEmpty) {
      payload = {
        ...payload,
        failure_reason: "tcc_empty_thumbnail",
        source_id: source.id,
        source_name: source.name,
      };
      return;
    }
    const [, nativeWindowId] = source.id.split(":");
    if (!nativeWindowId) throw new Error(`unexpected Electron media source id: ${source.id}`);
    const session = await renderer.evaluate(
      async ({ config, nativeWindowId, projectFolder }) => {
        const invoke = (
          window as never as {
            __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        return (await invoke("start_recording", {
          args: {
            project_folder: projectFolder,
            target: { kind: "window", window_id: nativeWindowId },
            width: config.width,
            height: config.height,
            fps: config.fps,
            audio_device_id: null,
            include_cursor: false,
          },
          onEvent: null,
        })) as { id: string };
      },
      { config, nativeWindowId, projectFolder },
    );

    const cpuSamples: number[] = [];
    const rssSamplesMB: number[] = [];
    const deadline = Date.now() + config.durationMs;
    while (Date.now() < deadline) {
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((metric) => ({
          cpu: metric.cpu.percentCPUUsage,
          rssMB: metric.memory.workingSetSize / 1024,
        })),
      );
      cpuSamples.push(metrics.reduce((total, metric) => total + metric.cpu, 0));
      rssSamplesMB.push(metrics.reduce((total, metric) => total + metric.rssMB, 0));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const result = await renderer.evaluate(async (sessionId) => {
      const encode = await import("/src/ipc/encode.ts");
      return encode.stopRecording({ id: sessionId });
    }, session.id);
    payload = {
      status: "passed",
      run_id: config.runId,
      source_id: source.id,
      source_name: source.name,
      requested_size: { width: config.width, height: config.height },
      requested_fps: config.fps,
      duration_ms: config.durationMs,
      cpu_p50: percentile(cpuSamples, 0.5),
      cpu_p95: percentile(cpuSamples, 0.95),
      peak_rss_mb: Math.max(0, ...rssSamplesMB),
      frame_count: result.frame_count,
      frames_written: result.frames_written,
      frames_dropped: result.frames_dropped,
      skipped_ticks: result.skipped_ticks,
      actual_capture_fps: result.actual_capture_fps,
      max_frame_gap_ms: result.health?.frame_gap_max_ms ?? null,
      output_path: result.output_path,
      capture_backend: result.capture_backend,
    };
  } catch (error) {
    payload = {
      ...payload,
      failure_reason: "electron_control_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.writeFile(config.resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await app.close();
    await fs.rm(projectFolder, { recursive: true, force: true });
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

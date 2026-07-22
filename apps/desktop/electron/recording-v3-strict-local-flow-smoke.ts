import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StartRecordingArgs } from "@storycapture/shared-types";
import {
  readExportRecordingSource,
  readRecordingInfo,
  readRecordingBundle,
} from "@storycapture/shared-types/recording-v2";
import { recordingV3DimensionsForViewport } from "@storycapture/shared-types/recording-v3";
import { app, BrowserWindow, type WebContents } from "electron";

import { discoverProjectRecordings } from "./ipc/recording-discovery";
import { probeRecording } from "./ipc/media-probe";
import { recordingV3NativeAddonPathForRuntime } from "./ipc/recording-v3-native-addon";
import {
  assertRecordingV3UploadAllowed,
  initializeRecordingV3ExportProvenance,
  recordingV3ModeForUploadPath,
  STRICT_LOCAL_UPLOAD_ERROR,
} from "./ipc/recording-v3-export-provenance";
import {
  acknowledgeStrictBrowserRecordingV3,
  pauseStrictBrowserRecordingV3,
  probeBrowserRecordingV3Capability,
  recordingV3SessionNativeStats,
  resumeStrictBrowserRecordingV3,
  setStrictBrowserRecordingV3Actions,
  startBrowserRecordingV3,
  stopStrictBrowserRecordingV3,
  strictBrowserRecordingV3ClockMs,
  strictBrowserRecordingV3Contents,
} from "./ipc/recording-strict-browser-lifecycle-v3";
import { exportRun } from "./ipc/legacy/export-render";
import { initializeExportOutputLifecycle } from "./ipc/legacy/export-output-lifecycle";
import { renderSessions } from "./ipc/legacy/shared";
import { isDevRuntime } from "./runtime";

const STRICT_LOCAL_VIEWPORT = { width: 1280, height: 800 } as const;
const EXPORT_VIEWPORT = { width: 1920, height: 1080 } as const;
const STRICT_LOCAL_DIMENSIONS = recordingV3DimensionsForViewport(
  "local",
  STRICT_LOCAL_VIEWPORT,
);

interface ResponsiveTargetState {
  innerWidth: number;
  innerHeight: number;
  visible: boolean;
  clicked: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

function captureContract() {
  return {
    version: 3 as const,
    guarantee_boundary: "electron_offscreen_delivery" as const,
    source_ordinal_kind: "electron_frame_count" as const,
    target_class: "browser" as const,
    exact_fps: { numerator: 60, denominator: 1 },
    dimensions: { ...STRICT_LOCAL_DIMENSIONS },
    cursor_policy: "sidecar_reconstructed" as const,
    audio_roles: [] as [],
  };
}

function startArgs(projectFolder: string): StartRecordingArgs {
  return {
    project_folder: projectFolder,
    target: { kind: "author_preview", stream_id: "recording-v3-strict-local-flow" },
    width: STRICT_LOCAL_VIEWPORT.width,
    height: STRICT_LOCAL_VIEWPORT.height,
    fps: 60,
    contract_version: 3,
    enforcement_mode: "strict",
    certification_mode: "local",
    delivery_policy: "strict",
    capture_contract: captureContract(),
    include_cursor: false,
    first_frame_timeout_ms: 10_000n,
  };
}

async function responsiveTargetState(contents: WebContents): Promise<ResponsiveTargetState> {
  return (await contents.executeJavaScript(`(() => {
    const target = document.getElementById("desktop-target");
    const rect = target?.getBoundingClientRect();
    const style = target ? getComputedStyle(target) : null;
    return {
      innerWidth,
      innerHeight,
      visible: Boolean(target && rect && rect.width > 0 && rect.height > 0 && style?.display !== "none" && style?.visibility !== "hidden"),
      clicked: Boolean(window.__storyCaptureStrictLocalWideFixture?.clicked),
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 },
    };
  })()`)) as ResponsiveTargetState;
}

async function inspectNarrowResponsiveTarget(url: string): Promise<ResponsiveTargetState> {
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 960,
    height: 540,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(url);
    return await responsiveTargetState(window.webContents);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function clickResponsiveTarget(contents: WebContents): Promise<ResponsiveTargetState> {
  const before = await responsiveTargetState(contents);
  const x = Math.round(before.rect.x + before.rect.width / 2);
  const y = Math.round(before.rect.y + before.rect.height / 2);
  contents.sendInputEvent({ type: "mouseMove", x, y });
  contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await responsiveTargetState(contents);
    if (state.clicked) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Responsive Recording V3 target did not receive the click within 2 seconds");
}

async function writeResultAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function waitForExport(jobId: string): Promise<NonNullable<ReturnType<typeof renderSessions.get>>> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const session = renderSessions.get(jobId);
    if (session && ["completed", "failed", "cancelled"].includes(session.job.status)) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Strict Local export ${jobId} timed out`);
}

export async function runRecordingV3StrictLocalFlowSmoke(resultPath: string): Promise<boolean> {
  const temporaryRoot = path.dirname(resultPath);
  const projectFolder = path.join(temporaryRoot, "strict-local-project");
  const runtimeStateRoot = path.join(temporaryRoot, "runtime-state");
  const outputFolder = path.join(projectFolder, "local-exports");
  const fixtureUrl = pathToFileURL(
    path.join(app.getAppPath(), "fixtures", "recording-v3-strict-local-wide", "index.html"),
  );
  const senderWindow = new BrowserWindow({ show: false });
  let sessionId: string | null = null;
  let phase = "initialization";
  try {
    await Promise.all([
      fs.mkdir(projectFolder, { recursive: true }),
      fs.mkdir(runtimeStateRoot, { recursive: true }),
    ]);
    await initializeExportOutputLifecycle(runtimeStateRoot);
    initializeRecordingV3ExportProvenance(runtimeStateRoot);
    const args = startArgs(projectFolder);
    phase = "responsive_breakpoint";
    const narrowTarget = await inspectNarrowResponsiveTarget(fixtureUrl.href);
    if (narrowTarget.innerWidth !== 960 || narrowTarget.visible) {
      throw new Error("Strict Local fixture target was not hidden at the 960px breakpoint");
    }
    phase = "source_preflight";
    const preflight = await probeBrowserRecordingV3Capability(args, fixtureUrl.href);
    if (
      !preflight.runtime_eligible ||
      !preflight.eligible ||
      preflight.enforcement_mode !== "strict" ||
      preflight.certification_mode !== "local" ||
      preflight.recording_mode !== "strict_local" ||
      preflight.matched_profile !== null ||
      preflight.manifest_id !== null ||
      preflight.source_rate.measured_fps?.numerator !== 60 ||
      preflight.source_rate.measured_fps.denominator !== 1
    ) {
      throw new Error(`Strict Local preflight failed: ${preflight.failure_codes.join(", ")}`);
    }

    phase = "recording_start";
    const started = await startBrowserRecordingV3(
      args,
      null,
      senderWindow.webContents,
      fixtureUrl.href,
    );
    sessionId = started.id;
    const recordingContents = strictBrowserRecordingV3Contents(sessionId);
    if (!recordingContents) throw new Error("Strict Local recording contents were unavailable");
    const wideTargetBefore = await responsiveTargetState(recordingContents);
    if (
      wideTargetBefore.innerWidth !== STRICT_LOCAL_VIEWPORT.width ||
      wideTargetBefore.innerHeight !== STRICT_LOCAL_VIEWPORT.height ||
      !wideTargetBefore.visible ||
      wideTargetBefore.clicked
    ) {
      throw new Error("Strict Local recording did not expose the desktop-only target");
    }
    const actionTimeMs = Math.max(0, strictBrowserRecordingV3ClockMs(sessionId) ?? 0);
    const wideTargetAfter = await clickResponsiveTarget(recordingContents);
    if (!wideTargetAfter.clicked) {
      throw new Error("Strict Local recording could not click the desktop-only target");
    }
    const center = {
      x: wideTargetBefore.rect.x + wideTargetBefore.rect.width / 2,
      y: wideTargetBefore.rect.y + wideTargetBefore.rect.height / 2,
    };
    if (
      !setStrictBrowserRecordingV3Actions(sessionId, [
        {
          step_id: "desktop-only-action",
          ordinal: 1,
          verb: "click",
          t_start_ms: Math.max(0, actionTimeMs - 100),
          t_action_ms: actionTimeMs,
          t_end_ms: actionTimeMs + 100,
          target: {
            kind: "element",
            label: "Desktop-only action",
            center,
            bounds: {
              x: wideTargetBefore.rect.x,
              y: wideTargetBefore.rect.y,
              w: wideTargetBefore.rect.width,
              h: wideTargetBefore.rect.height,
            },
          },
          secondary_target: null,
          pointer: { button: "left", effect: "click" },
          input_delivery: "browser_injected",
        },
      ])
    ) {
      throw new Error("Strict Local recording could not persist the responsive action");
    }
    phase = "recording_steady";
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    phase = "recording_pause";
    if (!(await pauseStrictBrowserRecordingV3(sessionId))) {
      throw new Error("Strict Local recording could not pause");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    phase = "recording_resume";
    if (!(await resumeStrictBrowserRecordingV3(sessionId))) {
      throw new Error("Strict Local recording could not resume");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    phase = "recording_stop";
    const result = await stopStrictBrowserRecordingV3(sessionId);
    if (!result || result.status !== "completed") {
      throw new Error("Strict Local recording did not complete");
    }
    if (
      result.delivery_policy !== "strict" ||
      result.recording_mode !== "strict_local" ||
      result.certification_profile !== null
    ) {
      throw new Error("Strict Local recording result lost its provenance");
    }

    phase = "bundle_validation";
    const rawManifest = JSON.parse(
      await fs.readFile(path.join(result.bundle_path, "manifest.json"), "utf8"),
    ) as unknown;
    const manifest = readRecordingBundle(rawManifest);
    if (
      !manifest ||
      manifest.schema_version !== 3 ||
      manifest.status !== "completed" ||
      manifest.recording_mode !== "strict_local" ||
      manifest.certification_profile !== null ||
      !manifest.proxy ||
      manifest.capture_contract.dimensions.logical_width !== STRICT_LOCAL_VIEWPORT.width ||
      manifest.capture_contract.dimensions.logical_height !== STRICT_LOCAL_VIEWPORT.height ||
      manifest.capture_contract.dimensions.capture_dpr !== 1 ||
      manifest.capture_contract.dimensions.physical_width !== STRICT_LOCAL_VIEWPORT.width ||
      manifest.capture_contract.dimensions.physical_height !== STRICT_LOCAL_VIEWPORT.height ||
      manifest.capture_contract.dimensions.requested_output_width !== STRICT_LOCAL_VIEWPORT.width ||
      manifest.capture_contract.dimensions.requested_output_height !== STRICT_LOCAL_VIEWPORT.height ||
      manifest.sidecars.actions_path !== "sidecars/actions.json" ||
      manifest.sidecars.cursor_path !== "sidecars/cursor.json" ||
      result.cadence_evidence.native_commits <= 0 ||
      result.cadence_evidence.native_commits !==
        result.cadence_evidence.artifact_decoded_frames
    ) {
      throw new Error("Strict Local bundle manifest failed validation");
    }
    if (!result.master_path || !result.proxy_path) {
      throw new Error("Strict Local recording result omitted master or proxy paths");
    }
    const [masterProbe, proxyProbe] = await Promise.all([
      probeRecording(result.master_path, { verifiedFullDecode: true }),
      probeRecording(result.proxy_path, { verifiedFullDecode: true }),
    ]);
    if (
      masterProbe.status !== "valid" ||
      masterProbe.width !== STRICT_LOCAL_VIEWPORT.width ||
      masterProbe.height !== STRICT_LOCAL_VIEWPORT.height ||
      proxyProbe.status !== "valid" ||
      proxyProbe.width !== STRICT_LOCAL_VIEWPORT.width ||
      proxyProbe.height !== STRICT_LOCAL_VIEWPORT.height
    ) {
      throw new Error("Strict Local master or proxy dimensions were invalid");
    }

    phase = "discovery";
    const discovered = await discoverProjectRecordings(path.join(projectFolder, "exports"));
    const recording = readRecordingInfo(
      discovered.find(
        (candidate) =>
          "bundle_path" in candidate && candidate.bundle_path === result.bundle_path,
      ),
    );
    if (
      !recording ||
      recording.version !== 3 ||
      recording.recording_mode !== "strict_local" ||
      recording.certification_profile !== null ||
      !recording.bundle_path ||
      !recording.master_path ||
      !recording.proxy_path ||
      !recording.cadence_evidence_path ||
      !recording.quality_evidence_path ||
      !recording.frame_ledger_path ||
      !recording.exact_source_fps ||
      !recording.source_frame_count ||
      recording.width !== STRICT_LOCAL_VIEWPORT.width ||
      recording.height !== STRICT_LOCAL_VIEWPORT.height
    ) {
      throw new Error("packaged-compatible discovery lost Strict Local provenance");
    }
    const recordingSource = readExportRecordingSource({
      version: 3,
      bundle_path: recording.bundle_path,
      master_path: recording.master_path,
      proxy_path: recording.proxy_path,
      cadence_evidence_path: recording.cadence_evidence_path,
      quality_evidence_path: recording.quality_evidence_path,
      frame_ledger_path: recording.frame_ledger_path,
      exact_source_fps: recording.exact_source_fps,
      source_frame_count: recording.source_frame_count,
      master_width: recording.width,
      master_height: recording.height,
      quality_verdict: recording.quality_verdict,
      guarantee_boundary: recording.guarantee_boundary,
      source_scope_verified: recording.source_scope_verified,
      recording_mode: recording.recording_mode,
      certification_profile_id: null,
    });
    if (!recordingSource || recordingSource.version !== 3) {
      throw new Error("Strict Local export source failed validation");
    }

    const durationMs = Math.max(1_000, recording.duration_ms ?? 1_000);
    const graph = {
      schema_version: 5,
      output_width: EXPORT_VIEWPORT.width,
      output_height: EXPORT_VIEWPORT.height,
      output_fps: 60,
      duration_ms: durationMs,
      video: [
        {
          type: "source",
          id: "strict-local-source",
          clip_id: "strict-local-clip",
          path: recording.proxy_path,
          pts_offset_ms: 0,
          timeline_start_ms: 0,
          duration_ms: durationMs,
          source_width: recording.width,
          source_height: recording.height,
          recording_source: recordingSource,
        },
      ],
      audio: [],
    };
    phase = "local_export";
    const exported = await exportRun({
      story_id: "recording-v3-strict-local-flow",
      graph_json: JSON.stringify(graph),
      outputs: [
        {
          format: "mp4",
          resolution: "1080p",
          output_width: EXPORT_VIEWPORT.width,
          output_height: EXPORT_VIEWPORT.height,
          fps: 60,
          quality: "high",
        },
      ],
      output_folder: outputFolder,
      base_name: "strict-local-flow",
      preset_id: null,
      priority: 0,
    });
    const exportSession = await waitForExport(exported.job_ids[0]!);
    if (
      exportSession.job.status !== "completed" ||
      exportSession.job.recording_mode !== "strict_local" ||
      !exportSession.job.output_path
    ) {
      throw new Error(`Strict Local export failed: ${exportSession.job.error ?? "unknown"}`);
    }
    const outputPath = exportSession.job.output_path;
    const suffixCount = (path.basename(outputPath).match(/-strict-local/g) ?? []).length;
    if (suffixCount !== 1 || !(await fs.stat(outputPath)).isFile()) {
      throw new Error("Strict Local export filename or artifact was invalid");
    }
    const exportProbe = await probeRecording(outputPath, { verifiedFullDecode: true });
    if (
      exportProbe.status !== "valid" ||
      exportProbe.width !== EXPORT_VIEWPORT.width ||
      exportProbe.height !== EXPORT_VIEWPORT.height
    ) {
      throw new Error("Strict Local export dimensions were invalid");
    }

    phase = "upload_guard_reopen";
    initializeRecordingV3ExportProvenance(runtimeStateRoot);
    const persistedMode = await recordingV3ModeForUploadPath(outputPath);
    let uploadRejected = false;
    try {
      await assertRecordingV3UploadAllowed(outputPath, null);
    } catch (error) {
      uploadRejected =
        error instanceof Error && error.message === STRICT_LOCAL_UPLOAD_ERROR;
    }
    if (persistedMode !== "strict_local" || !uploadRejected) {
      throw new Error("Strict Local export upload guard did not survive registry reopen");
    }

    const addonPath = recordingV3NativeAddonPathForRuntime({
      app,
      resourcesPath: process.resourcesPath,
      desktopRoot: app.getAppPath(),
    });
    const passed =
      isDevRuntime(app) &&
      addonPath.includes(path.join("native", "macos-recording-v3", ".build")) &&
      result.recording_mode === "strict_local";
    await writeResultAtomic(resultPath, {
      schema_version: 1,
      passed,
      addon_path: addonPath,
      preflight,
      result,
      dimensions: STRICT_LOCAL_DIMENSIONS,
      export_dimensions: EXPORT_VIEWPORT,
      narrow_target: narrowTarget,
      wide_target_before: wideTargetBefore,
      wide_target_after: wideTargetAfter,
      master_probe: masterProbe,
      proxy_probe: proxyProbe,
      manifest_recording_mode: manifest.recording_mode,
      discovered_recording_mode: recording.recording_mode,
      preview_path: recording.proxy_path,
      export_path: outputPath,
      export_recording_mode: exportSession.job.recording_mode,
      export_probe: exportProbe,
      persisted_upload_mode: persistedMode,
      upload_rejected: uploadRejected,
    });
    return passed;
  } catch (error) {
    await writeResultAtomic(resultPath, {
      schema_version: 1,
      passed: false,
      phase,
      native_stats: sessionId ? recordingV3SessionNativeStats(sessionId) : null,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return false;
  } finally {
    if (sessionId) acknowledgeStrictBrowserRecordingV3(sessionId);
    if (!senderWindow.isDestroyed()) senderWindow.destroy();
  }
}

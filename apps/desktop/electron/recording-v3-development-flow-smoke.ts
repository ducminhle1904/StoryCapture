import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { StartRecordingArgs } from "@storycapture/shared-types";
import {
  readExportRecordingSource,
  readRecordingInfo,
  readRecordingBundle,
} from "@storycapture/shared-types/recording-v2";
import { app, BrowserWindow } from "electron";

import { discoverProjectRecordings } from "./ipc/recording-discovery";
import { recordingV3NativeAddonPathForRuntime } from "./ipc/recording-v3-native-addon";
import {
  assertRecordingV3UploadAllowed,
  initializeRecordingV3ExportProvenance,
  recordingV3ModeForUploadPath,
  UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR,
} from "./ipc/recording-v3-export-provenance";
import {
  acknowledgeStrictBrowserRecordingV3,
  pauseStrictBrowserRecordingV3,
  probeBrowserRecordingV3Capability,
  recordingV3SessionNativeStats,
  resumeStrictBrowserRecordingV3,
  startBrowserRecordingV3,
  stopStrictBrowserRecordingV3,
} from "./ipc/recording-strict-browser-lifecycle-v3";
import { exportRun } from "./ipc/legacy/export-render";
import { initializeExportOutputLifecycle } from "./ipc/legacy/export-output-lifecycle";
import { renderSessions } from "./ipc/legacy/shared";
import { isDevRuntime } from "./runtime";

function captureContract() {
  return {
    version: 3 as const,
    guarantee_boundary: "electron_offscreen_delivery" as const,
    source_ordinal_kind: "electron_frame_count" as const,
    target_class: "browser" as const,
    exact_fps: { numerator: 60, denominator: 1 },
    dimensions: {
      logical_width: 960,
      logical_height: 540,
      capture_dpr: 2,
      physical_width: 1920,
      physical_height: 1080,
      requested_output_width: 1920,
      requested_output_height: 1080,
    },
    cursor_policy: "sidecar_reconstructed" as const,
    audio_roles: [] as [],
  };
}

function startArgs(projectFolder: string): StartRecordingArgs {
  return {
    project_folder: projectFolder,
    target: { kind: "author_preview", stream_id: "recording-v3-development-flow" },
    width: 960,
    height: 540,
    fps: 60,
    contract_version: 3,
    intent: "development",
    delivery_policy: "development",
    capture_contract: captureContract(),
    include_cursor: false,
    first_frame_timeout_ms: 10_000n,
  };
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
  throw new Error(`development export ${jobId} timed out`);
}

export async function runRecordingV3DevelopmentFlowSmoke(resultPath: string): Promise<boolean> {
  const temporaryRoot = path.dirname(resultPath);
  const projectFolder = path.join(temporaryRoot, "development-project");
  const runtimeStateRoot = path.join(temporaryRoot, "runtime-state");
  const outputFolder = path.join(projectFolder, "local-exports");
  const fixtureUrl = pathToFileURL(
    path.join(app.getAppPath(), "fixtures", "recording-v3-certification", "index.html"),
  );
  fixtureUrl.searchParams.set("fixture", "motion");
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
    phase = "source_preflight";
    const preflight = await probeBrowserRecordingV3Capability(args, fixtureUrl.href);
    if (
      !preflight.development_eligible ||
      preflight.strict_eligible ||
      preflight.recording_mode !== "uncertified_development" ||
      preflight.matched_profile !== null ||
      preflight.manifest_id !== null
    ) {
      throw new Error(`development preflight failed: ${preflight.failure_codes.join(", ")}`);
    }

    phase = "recording_start";
    const started = await startBrowserRecordingV3(
      args,
      null,
      senderWindow.webContents,
      fixtureUrl.href,
    );
    sessionId = started.id;
    phase = "recording_steady";
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    phase = "recording_pause";
    if (!(await pauseStrictBrowserRecordingV3(sessionId))) {
      throw new Error("development recording could not pause");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    phase = "recording_resume";
    if (!(await resumeStrictBrowserRecordingV3(sessionId))) {
      throw new Error("development recording could not resume");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    phase = "recording_stop";
    const result = await stopStrictBrowserRecordingV3(sessionId);
    if (!result || result.status !== "completed") {
      throw new Error("development recording did not complete");
    }
    if (
      result.delivery_policy !== "development" ||
      result.recording_mode !== "uncertified_development" ||
      result.certification_profile !== null
    ) {
      throw new Error("development recording result lost its provenance");
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
      manifest.recording_mode !== "uncertified_development" ||
      manifest.certification_profile !== null ||
      !manifest.proxy
    ) {
      throw new Error("development bundle manifest failed validation");
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
      recording.recording_mode !== "uncertified_development" ||
      recording.certification_profile !== null ||
      !recording.bundle_path ||
      !recording.master_path ||
      !recording.proxy_path ||
      !recording.cadence_evidence_path ||
      !recording.quality_evidence_path ||
      !recording.frame_ledger_path ||
      !recording.exact_source_fps ||
      !recording.source_frame_count ||
      !recording.width ||
      !recording.height
    ) {
      throw new Error("packaged-compatible discovery lost development provenance");
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
      throw new Error("development export source failed validation");
    }

    const durationMs = Math.max(1_000, recording.duration_ms ?? 1_000);
    const graph = {
      schema_version: 5,
      output_width: 1920,
      output_height: 1080,
      output_fps: 60,
      duration_ms: durationMs,
      video: [
        {
          type: "source",
          id: "development-source",
          clip_id: "development-clip",
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
      story_id: "recording-v3-development-flow",
      graph_json: JSON.stringify(graph),
      outputs: [
        {
          format: "mp4",
          resolution: "1080p",
          output_width: 1920,
          output_height: 1080,
          fps: 60,
          quality: "high",
        },
      ],
      output_folder: outputFolder,
      base_name: "development-flow",
      preset_id: null,
      priority: 0,
    });
    const exportSession = await waitForExport(exported.job_ids[0]!);
    if (
      exportSession.job.status !== "completed" ||
      exportSession.job.recording_mode !== "uncertified_development" ||
      !exportSession.job.output_path
    ) {
      throw new Error(`development local export failed: ${exportSession.job.error ?? "unknown"}`);
    }
    const outputPath = exportSession.job.output_path;
    const suffixCount = (path.basename(outputPath).match(/-uncertified-dev/g) ?? []).length;
    if (suffixCount !== 1 || !(await fs.stat(outputPath)).isFile()) {
      throw new Error("development export filename or artifact was invalid");
    }

    phase = "upload_guard_reopen";
    initializeRecordingV3ExportProvenance(runtimeStateRoot);
    const persistedMode = await recordingV3ModeForUploadPath(outputPath);
    let uploadRejected = false;
    try {
      await assertRecordingV3UploadAllowed(outputPath, null);
    } catch (error) {
      uploadRejected =
        error instanceof Error && error.message === UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR;
    }
    if (persistedMode !== "uncertified_development" || !uploadRejected) {
      throw new Error("development export upload guard did not survive registry reopen");
    }

    const addonPath = recordingV3NativeAddonPathForRuntime({
      app,
      resourcesPath: process.resourcesPath,
      desktopRoot: app.getAppPath(),
    });
    const passed =
      isDevRuntime(app) &&
      addonPath.includes(path.join("native", "macos-recording-v3", ".build")) &&
      result.recording_mode === "uncertified_development";
    await writeResultAtomic(resultPath, {
      schema_version: 1,
      passed,
      addon_path: addonPath,
      preflight,
      result,
      manifest_recording_mode: manifest.recording_mode,
      discovered_recording_mode: recording.recording_mode,
      preview_path: recording.proxy_path,
      export_path: outputPath,
      export_recording_mode: exportSession.job.recording_mode,
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

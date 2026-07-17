import { spawn } from "node:child_process";
import { watch as watchFs } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExportPreflightArgs } from "@storycapture/shared-types";
import { app, dialog, type IpcMainInvokeEvent, shell } from "electron";
import { DEV_RELAUNCH_EXIT_CODE, isDevRuntime } from "../../runtime";
import { readRecordingActionsSidecar } from "../action-sidecar-reader";
import { readJson, writeJson } from "../json-store";
import { logFromFrontend } from "../log-store";
import { userDataPath } from "../paths";
import { sessionId } from "../session";
import type { InvokeEnvelope } from "../types";
import { checkElectronUpdate, getPendingUpdateInfo, installElectronUpdate } from "../update-store";
import {
  authorSession,
  authorSnapshotCapture,
  authorSnapshotGet,
  authorSnapshotList,
  authorSnapshotValidate,
  captureTargetThumbnail,
  clampDimension,
  dispatchAuthorInput,
  electronDialogFilters,
  emitEvent,
  isAuthorPreviewTarget,
  pickerCancel,
  pickerStampStepId,
  pickerStartAuthor,
  resolveActiveAuthorPreviewTarget,
  showDialogMessage,
  startAuthorPreviewSession,
  startCaptureStream,
  startPreviewStream,
  startRecording,
  stopAuthorPreviewSession,
  stopCaptureStream,
  stopPreviewStream,
  windowInfo,
} from "./capture-preview";
import { exportPreflight } from "./export-preflight";
import {
  exportRun,
  renderCancel,
  renderEnqueue,
  renderListActive,
  streamRenderProgress,
  validateExportOutput,
} from "./export-render";
import {
  bufferFromUnknown,
  bytesWithReadCount,
  closeFsResource,
  closeShellResource,
  fileInfoFromStats,
  fsEntrySize,
  fsFileResource,
  fsInvokeOptions,
  fsLineEncoding,
  fsPathField,
  fsResource,
  getStore,
  handleLspRequest,
  loadStore,
  normalizeFsPath,
  openFsFile,
  pathFromFsArgs,
  screenPermissionReport,
} from "./platform";
import {
  exportPresetsCatalogue,
  presetExport,
  presetImport,
  readPresets,
  readRecordingSidecar,
  soundLibraryList,
} from "./post-production";
import {
  createProject,
  getProjectWorkflow,
  listProjectRecordings,
  openProject,
  pathExists,
  readProjects,
  removeProject,
  timelineLoad,
  timelineSave,
  updateProjectWorkflow,
} from "./projects";
import { setRecordingAudio, stopRecording } from "./recording";
import {
  emptySessionRollup,
  keyDelete,
  keyGetPresence,
  keySet,
  keyTest,
  listTtsVoices,
  nlProviderUnavailable,
  providerId,
  ttsApplySyncWithoutCachedClips,
  ttsProviderUnavailable,
} from "./secrets-tts";
import {
  activePickerStreams,
  authorPreviewSessions,
  autoUpdater,
  type CaptureTarget,
  captureTargetPath,
  channelIdFrom,
  displayInfo,
  type ExportOutput,
  type ExportRunArgs,
  eventListeners,
  fsResources,
  type OpenDialogSpec,
  pluginLogLevel,
  recordingSessions,
  restoreElectronWindowState,
  type SaveDialogSpec,
  saveElectronWindowState,
  sendChannel,
  shellArgs,
  shellOptions,
  shellProcesses,
  shellSignal,
  simulatorSessions,
  stores,
  takeNextEventListenerId,
  takeNextResourceId,
  updaterMetadata,
  updaterResources,
  type WorkflowState,
  windowStatePath,
} from "./shared";
import {
  dryRunCancel,
  dryRunStart,
  launchAutomationCommand,
  simulatorPromoteFallback,
  simulatorStartCommand,
} from "./story-runner";
import {
  cancelUpload,
  completeWebOauth,
  disconnectWebAccount,
  flushSyncQueue,
  getSyncStatus,
  getWebAccount,
  getWebApiToken,
  listAudioInputs,
  startWebOauth,
  syncProjectMetadata,
  updateRecordingStatus,
  uploadStatus,
  uploadVideoWithStatus,
} from "./web";

export async function handleLegacyInvoke(
  event: IpcMainInvokeEvent,
  { cmd, args, options }: InvokeEnvelope,
): Promise<unknown> {
  switch (cmd) {
    case "list_audio_inputs":
      return listAudioInputs(event.sender);
    case "probe_hw_encoders":
    case "refresh_hw_encoders":
      return {
        available: ["software"],
        preferred: "software",
        encoders: [{ encoder: "software", available: true, fallback_reason: null }],
      };
    case "start_recording":
      return startRecording(
        (args as { args?: unknown } | undefined)?.args,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        event.sender,
      );
    case "electron_recording_set_audio":
      return setRecordingAudio(args);
    case "stop_recording":
      return stopRecording(
        (args as { session?: { id?: string } | undefined } | undefined)?.session,
      );
    case "pause_recording": {
      const id = String((args as { session?: { id?: string } } | undefined)?.session?.id ?? "");
      const session = recordingSessions.get(id);
      if (!session) throw new Error(`recording session ${id} not found`);
      session.paused = true;
      session.lifecycle = "paused";
      session.mediaClock.pause();
      session.pauseGate.pause();
      return { status: session.lifecycle };
    }
    case "resume_recording": {
      const id = String((args as { session?: { id?: string } } | undefined)?.session?.id ?? "");
      const session = recordingSessions.get(id);
      if (!session) throw new Error(`recording session ${id} not found`);
      session.paused = false;
      session.lifecycle = "recording";
      session.mediaClock.resume();
      session.pauseGate.resume();
      return { status: session.lifecycle };
    }
    case "launch_automation":
      return launchAutomationCommand((args ?? {}) as Record<string, unknown>, event.sender);
    case "start_preview_stream":
      return startPreviewStream();
    case "stop_preview_stream":
      return stopPreviewStream();
    case "start_author_preview":
      return startAuthorPreviewSession((args ?? {}) as Record<string, unknown>, event.sender);
    case "stop_author_preview":
      return stopAuthorPreviewSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      );
    case "pause_author_preview":
      authorSession(String((args as { streamId?: string } | undefined)?.streamId ?? "")).paused =
        true;
      return null;
    case "resume_author_preview":
      authorSession(String((args as { streamId?: string } | undefined)?.streamId ?? "")).paused =
        false;
      return null;
    case "set_author_preview_viewport": {
      const payload = args as
        | { streamId?: string; args?: { width?: number; height?: number } }
        | undefined;
      const session = authorSession(String(payload?.streamId ?? ""));
      session.window.setContentSize(
        clampDimension(payload?.args?.width, 1280),
        clampDimension(payload?.args?.height, 800),
      );
      return null;
    }
    case "set_author_preview_url": {
      const payload = args as { streamId?: string; url?: string } | undefined;
      const url = String(payload?.url ?? "about:blank");
      await authorSession(String(payload?.streamId ?? "")).window.loadURL(url);
      return null;
    }
    case "author_preview_back":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.navigationHistory.goBack();
      return null;
    case "author_preview_forward":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.navigationHistory.goForward();
      return null;
    case "author_preview_reload":
      authorSession(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
      ).window.webContents.reload();
      return null;
    case "attach_author_driver":
      authorSession(String((args as { streamId?: string } | undefined)?.streamId ?? ""));
      return null;
    case "author_dispatch_input":
      dispatchAuthorInput(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
        ((args as { event?: Record<string, unknown> } | undefined)?.event ?? {}) as Record<
          string,
          unknown
        >,
      );
      return null;
    case "picker_start_author":
      return pickerStartAuthor((args ?? {}) as Record<string, unknown>);
    case "picker_start": {
      const first = authorPreviewSessions.keys().next().value as string | undefined;
      if (!first)
        return {
          json: JSON.stringify({
            cancelled: true,
            reason: "no-author-preview",
          }),
        };
      return pickerStartAuthor({
        ...(args as Record<string, unknown> | undefined),
        streamId: first,
      });
    }
    case "picker_cancel":
      return pickerCancel();
    case "picker_is_active":
      return activePickerStreams.size > 0;
    case "picker_stamp_step_id":
      return pickerStampStepId((args ?? {}) as Record<string, unknown>);
    case "simulator_start":
      return simulatorStartCommand((args ?? {}) as Record<string, unknown>, event.sender);
    case "simulator_step_to":
      return null;
    case "simulator_cancel": {
      const id = String((args as { sessionId?: string } | undefined)?.sessionId ?? "");
      const session = simulatorSessions.get(id);
      if (session) {
        session.cancelled = true;
        sendChannel(session.sender, session.channelId, { type: "cancelled" });
        simulatorSessions.delete(id);
      }
      return null;
    }
    case "simulator_promote_fallback":
      return simulatorPromoteFallback(
        String((args as { sessionId?: unknown } | undefined)?.sessionId ?? ""),
        Number((args as { ordinal?: unknown } | undefined)?.ordinal ?? 0),
      );
    case "render_enqueue":
      return renderEnqueue((args as { job?: unknown } | undefined)?.job);
    case "render_cancel":
      return renderCancel(String((args as { jobId?: unknown } | undefined)?.jobId ?? ""));
    case "render_list_active":
      return renderListActive(String((args as { storyId?: unknown } | undefined)?.storyId ?? ""));
    case "stream_render_progress":
      return streamRenderProgress(args, event.sender);
    case "key_get_presence":
      return keyGetPresence(providerId((args as { provider?: unknown } | undefined)?.provider));
    case "key_set":
      return keySet(
        providerId((args as { provider?: unknown } | undefined)?.provider),
        String((args as { key?: unknown } | undefined)?.key ?? ""),
      );
    case "key_delete":
      return keyDelete(providerId((args as { provider?: unknown } | undefined)?.provider));
    case "key_test":
      return keyTest(providerId((args as { provider?: unknown } | undefined)?.provider));
    case "get_web_account":
      return getWebAccount();
    case "get_web_api_token":
      return getWebApiToken();
    case "get_sync_status":
      return getSyncStatus();
    case "get_upload_status":
      return uploadStatus;
    case "start_web_oauth":
      return startWebOauth();
    case "complete_web_oauth":
      return completeWebOauth();
    case "disconnect_web_account":
      return disconnectWebAccount();
    case "sync_project_metadata":
      return syncProjectMetadata((args ?? {}) as Record<string, unknown>);
    case "flush_sync_queue":
      return flushSyncQueue();
    case "upload_video":
      return uploadVideoWithStatus((args ?? {}) as Record<string, unknown>, event.sender);
    case "cancel_upload":
      return cancelUpload();
    case "update_recording_status":
      return updateRecordingStatus((args ?? {}) as Record<string, unknown>);
    case "author_snapshot_list":
      return authorSnapshotList(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.projectDir ??
            (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.project_dir ??
            "",
        ),
      );
    case "author_snapshot_get":
      return authorSnapshotGet(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.projectDir ??
            (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
      );
    case "author_snapshot_capture":
      return authorSnapshotCapture(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.projectDir ??
            (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
      );
    case "author_snapshot_validate":
      return authorSnapshotValidate(
        String(
          (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.projectDir ??
            (args as { projectDir?: unknown; project_dir?: unknown } | undefined)?.project_dir ??
            "",
        ),
        String((args as { url?: unknown } | undefined)?.url ?? ""),
        (args as { target?: unknown } | undefined)?.target,
      );
    case "dryrun_start":
      return dryRunStart((args ?? {}) as Record<string, unknown>, event.sender);
    case "dryrun_cancel":
      return dryRunCancel(String((args as { taskId?: unknown } | undefined)?.taskId ?? ""));
    case "lsp_request":
      return handleLspRequest((args ?? {}) as Record<string, unknown>, event.sender);
    case "nl_get_session_id":
      return sessionId;
    case "nl_load_history":
      return [];
    case "nl_chat_send":
      return nlProviderUnavailable(
        (args as { providerOverride?: unknown } | undefined)?.providerOverride,
      );
    case "nl_cancel":
    case "nl_diff_apply":
    case "nl_diff_reject":
      return null;
    case "nl_regen_step":
      return nlProviderUnavailable("anthropic");
    case "session_get_rollup":
      return emptySessionRollup();
    case "tts_voice_list":
      return listTtsVoices((args as { provider?: unknown } | undefined)?.provider);
    case "tts_generate":
    case "tts_regenerate_clip":
      return ttsProviderUnavailable((args as { provider?: unknown } | undefined)?.provider);
    case "tts_apply_sync":
      return ttsApplySyncWithoutCachedClips(
        (args as { stepTimings?: unknown } | undefined)?.stepTimings,
      );
    case "tts_gc_cache":
      return 0;
    case "list_projects":
      return readProjects();
    case "create_project":
      return createProject((args as { args?: unknown } | undefined)?.args);
    case "open_project":
      return openProject(String((args as { args?: { id?: string } } | undefined)?.args?.id ?? ""));
    case "remove_project":
      return removeProject(
        String((args as { args?: { id?: string } } | undefined)?.args?.id ?? ""),
      );
    case "get_project_workflow":
      return getProjectWorkflow(
        String((args as { args?: { id?: string } } | undefined)?.args?.id ?? ""),
      );
    case "update_project_workflow": {
      const payload = (
        args as { args?: { id?: string; workflow_state?: WorkflowState } } | undefined
      )?.args;
      if (!payload?.workflow_state) throw new Error("workflow_state required");
      return updateProjectWorkflow(String(payload.id ?? ""), payload.workflow_state);
    }
    case "list_project_recordings":
      return listProjectRecordings(
        String((args as { args?: { id?: string } } | undefined)?.args?.id ?? ""),
      );
    case "timeline_load":
      return timelineLoad(String((args as { storyId?: string } | undefined)?.storyId ?? ""));
    case "timeline_save": {
      const payload = args as { storyId?: string; layoutJson?: string } | undefined;
      await timelineSave(String(payload?.storyId ?? ""), String(payload?.layoutJson ?? ""));
      return null;
    }
    case "get_recording_actions":
      return readRecordingActionsSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args?.recording_path ?? "",
        ),
      );
    case "get_recording_trajectory":
      return readRecordingSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args?.recording_path ?? "",
        ),
        "trajectory",
      );
    case "get_recording_step_timing":
      return readRecordingSidecar(
        String(
          (args as { args?: { recording_path?: string } } | undefined)?.args?.recording_path ?? "",
        ),
        "steps",
      );
    case "preset_list":
      return readPresets(String((args as { scope?: string } | undefined)?.scope ?? "project"));
    case "preset_import":
      return presetImport(
        String((args as { path?: string } | undefined)?.path ?? ""),
        String((args as { scope?: string } | undefined)?.scope ?? "project"),
      );
    case "preset_export":
      return presetExport(
        String((args as { id?: string } | undefined)?.id ?? ""),
        String((args as { out?: string } | undefined)?.out ?? ""),
      );
    case "sound_library_list":
      return soundLibraryList(
        String((args as { category?: string } | undefined)?.category ?? "sfx"),
      );
    case "export_get_presets":
      return exportPresetsCatalogue();
    case "export_preflight":
      return exportPreflight(
        (args as { args?: ExportPreflightArgs } | undefined)?.args ?? {
          graph_json: "",
          outputs: [],
          compiler_issues: [],
        },
      );
    case "export_validate_config":
      validateExportOutput(
        (args as { cfg?: ExportOutput } | undefined)?.cfg ?? ({} as ExportOutput),
      );
      return null;
    case "export_run":
      return exportRun(
        (args as { args?: ExportRunArgs } | undefined)?.args ?? ({} as ExportRunArgs),
      );
    case "list_displays":
      return displayInfo();
    case "list_windows":
      return windowInfo();
    case "list_capture_targets":
      return {
        displays: displayInfo(),
        windows: await windowInfo(),
        playwright_auto_available: false,
      };
    case "get_capture_target":
      return readJson<CaptureTarget | null>(captureTargetPath(), null);
    case "set_capture_target":
      if (isAuthorPreviewTarget((args as { target?: CaptureTarget } | undefined)?.target)) {
        throw new Error("author_preview cannot be persisted as a capture target");
      }
      await writeJson(
        captureTargetPath(),
        (args as { target?: CaptureTarget } | undefined)?.target ?? null,
      );
      return null;
    case "capture_target_thumbnail": {
      const payload = args as
        | { target?: CaptureTarget; maxWidth?: number; maxHeight?: number }
        | undefined;
      if (!payload?.target) throw new Error("target required");
      return captureTargetThumbnail(
        payload.target,
        payload.maxWidth ?? 320,
        payload.maxHeight ?? 180,
      );
    }
    case "check_screen_capture_permission":
      return screenPermissionReport(false);
    case "request_screen_capture_access":
      return screenPermissionReport(true);
    case "open_screen_capture_prefs":
      if (process.platform === "darwin") {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
      }
      return null;
    case "relaunch_app":
      if (isDevRuntime(app)) {
        app.exit(DEV_RELAUNCH_EXIT_CODE);
      } else {
        app.relaunch();
        app.exit(0);
      }
      return null;
    case "resolve_playwright_target":
      return resolveActiveAuthorPreviewTarget(
        String((args as { streamId?: string } | undefined)?.streamId ?? ""),
        Boolean((args as { ensureVisible?: boolean } | undefined)?.ensureVisible),
      );
    case "is_stage_manager_enabled":
      return false;
    case "start_capture":
      return startCaptureStream(
        (args as { cfg?: unknown } | undefined)?.cfg,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        (args as { onFrame?: unknown } | undefined)?.onFrame,
        event.sender,
      );
    case "start_capture_target":
      return startCaptureStream(
        (args as { args?: unknown } | undefined)?.args,
        (args as { onEvent?: unknown } | undefined)?.onEvent,
        (args as { onFrame?: unknown } | undefined)?.onFrame,
        event.sender,
      );
    case "stop_capture":
      return stopCaptureStream((args as { session?: unknown } | undefined)?.session);
    case "plugin:dialog|open": {
      const openOptions = (args as { options?: OpenDialogSpec }).options;
      const result = await dialog.showOpenDialog({
        title: openOptions?.title,
        defaultPath: openOptions?.defaultPath,
        filters: electronDialogFilters(openOptions?.filters),
        properties: [
          openOptions?.directory ? "openDirectory" : "openFile",
          openOptions?.multiple ? "multiSelections" : undefined,
          openOptions?.canCreateDirectories ? "createDirectory" : undefined,
        ].filter(
          (
            property,
          ): property is "openDirectory" | "openFile" | "multiSelections" | "createDirectory" =>
            property === "openDirectory" ||
            property === "openFile" ||
            property === "multiSelections" ||
            property === "createDirectory",
        ),
      });
      if (result.canceled) return null;
      return openOptions?.multiple ? result.filePaths : (result.filePaths[0] ?? null);
    }
    case "plugin:dialog|save": {
      const saveOptions = (args as { options?: SaveDialogSpec }).options;
      const result = await dialog.showSaveDialog({
        title: saveOptions?.title,
        defaultPath: saveOptions?.defaultPath,
        filters: electronDialogFilters(saveOptions?.filters),
        properties: [saveOptions?.canCreateDirectories ? "createDirectory" : undefined].filter(
          (property): property is "createDirectory" => property === "createDirectory",
        ),
      });
      return result.canceled ? null : (result.filePath ?? null);
    }
    case "plugin:dialog|message":
      return showDialogMessage(args);
    case "plugin:event|listen": {
      const payload = args as { event?: string; handler?: number } | undefined;
      const eventId = takeNextEventListenerId();
      const handlerId = Number(payload?.handler);
      if (!payload?.event || !Number.isFinite(handlerId)) {
        throw new Error("event listener requires event and handler");
      }
      eventListeners.set(eventId, {
        event: payload.event,
        eventId,
        handlerId,
        sender: event.sender,
      });
      return eventId;
    }
    case "plugin:event|unlisten":
      eventListeners.delete(Number((args as { eventId?: unknown } | undefined)?.eventId));
      return null;
    case "plugin:event|emit":
      emitEvent(
        String((args as { event?: string } | undefined)?.event ?? ""),
        (args as { payload?: unknown } | undefined)?.payload,
      );
      return null;
    case "plugin:event|emit_to":
      emitEvent(
        String((args as { event?: string } | undefined)?.event ?? ""),
        (args as { payload?: unknown } | undefined)?.payload,
      );
      return null;
    case "plugin:resources|close": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      if (await closeFsResource(rid)) return null;
      if (closeShellResource(rid)) return null;
      if (typeof rid === "number" && updaterResources.delete(rid)) return null;
      if (typeof rid === "number" && stores.has(rid)) {
        stores.delete(rid);
        return null;
      }
      return null;
    }
    case "plugin:log|log": {
      const payload = args as
        | {
            level?: unknown;
            message?: unknown;
            location?: unknown;
            file?: unknown;
            line?: unknown;
            keyValues?: unknown;
          }
        | undefined;
      return logFromFrontend({
        level: pluginLogLevel(payload?.level),
        message: String(payload?.message ?? ""),
        source: typeof payload?.file === "string" ? payload.file : "plugin-log",
        fields: [
          ["location", String(payload?.location ?? "")],
          ["line", String(payload?.line ?? "")],
          ["keyValues", JSON.stringify(payload?.keyValues ?? null)],
        ],
      });
    }
    case "plugin:os|locale":
      return app.getLocale() || Intl.DateTimeFormat().resolvedOptions().locale || null;
    case "plugin:os|hostname":
      return os.hostname();
    case "plugin:process|restart":
      app.relaunch();
      app.exit(0);
      return null;
    case "plugin:process|exit":
      app.exit(Number((args as { code?: unknown } | undefined)?.code ?? 0));
      return null;
    case "plugin:updater|check": {
      const update = await checkElectronUpdate();
      const pendingUpdateInfo = getPendingUpdateInfo();
      return pendingUpdateInfo && update ? updaterMetadata(pendingUpdateInfo) : null;
    }
    case "plugin:updater|download": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      if (typeof rid !== "number" || !updaterResources.has(rid))
        throw new Error("unknown update resource");
      const bytesRid = takeNextResourceId();
      updaterResources.add(bytesRid);
      if (app.isPackaged || process.env.STORYCAPTURE_DEBUG_UPDATER) {
        const channelId = channelIdFrom((args as { onEvent?: unknown } | undefined)?.onEvent);
        sendChannel(event.sender, channelId, { event: "Started" });
        await autoUpdater.downloadUpdate();
        sendChannel(event.sender, channelId, { event: "Finished" });
      }
      return bytesRid;
    }
    case "plugin:updater|install":
      return installElectronUpdate();
    case "plugin:updater|download_and_install": {
      const channelId = channelIdFrom((args as { onEvent?: unknown } | undefined)?.onEvent);
      sendChannel(event.sender, channelId, { event: "Started" });
      await installElectronUpdate();
      sendChannel(event.sender, channelId, { event: "Finished" });
      return null;
    }
    case "plugin:window-state|filename":
      return windowStatePath();
    case "plugin:window-state|save_window_state":
      await saveElectronWindowState();
      return null;
    case "plugin:window-state|restore_state":
      await restoreElectronWindowState();
      return null;
    case "plugin:shell|open": {
      const target = String((args as { path?: unknown } | undefined)?.path ?? "");
      if (!target) throw new Error("shell.open requires a path");
      const result = /^[a-z][a-z0-9+.-]*:/i.test(target)
        ? await shell.openExternal(target)
        : await shell.openPath(target);
      if (result) throw new Error(result);
      return null;
    }
    case "plugin:shell|execute": {
      const payload = args as { program?: unknown; args?: unknown; options?: unknown } | undefined;
      const program = String(payload?.program ?? "");
      if (!program) throw new Error("shell.execute requires a program");
      const options = shellOptions(payload?.options);
      return new Promise((resolve, reject) => {
        const child = spawn(program, shellArgs(payload?.args), {
          cwd: options.cwd,
          env: options.env,
          shell: false,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolve({
            code,
            signal: shellSignal(signal),
            stdout: Buffer.concat(stdout).toString(options.encoding),
            stderr: Buffer.concat(stderr).toString(options.encoding),
          });
        });
      });
    }
    case "plugin:shell|spawn": {
      const payload = args as
        | {
            program?: unknown;
            args?: unknown;
            options?: unknown;
            onEvent?: unknown;
          }
        | undefined;
      const program = String(payload?.program ?? "");
      if (!program) throw new Error("shell.spawn requires a program");
      const options = shellOptions(payload?.options);
      const child = spawn(program, shellArgs(payload?.args), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
      });
      const pid = child.pid ?? takeNextResourceId();
      shellProcesses.set(pid, { child });
      const channelId = channelIdFrom(payload?.onEvent);
      child.stdout.on("data", (chunk: Buffer) => {
        sendChannel(event.sender, channelId, {
          event: "Stdout",
          payload: chunk.toString(options.encoding),
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        sendChannel(event.sender, channelId, {
          event: "Stderr",
          payload: chunk.toString(options.encoding),
        });
      });
      child.on("error", (error) => {
        sendChannel(event.sender, channelId, {
          event: "Error",
          payload: error.message,
        });
      });
      child.on("close", (code, signal) => {
        shellProcesses.delete(pid);
        sendChannel(event.sender, channelId, {
          event: "Terminated",
          payload: { code, signal: shellSignal(signal) },
        });
      });
      return pid;
    }
    case "plugin:shell|stdin_write": {
      const payload = args as { pid?: unknown; buffer?: unknown } | undefined;
      const child = shellProcesses.get(Number(payload?.pid))?.child;
      if (!child) throw new Error("unknown shell process");
      child.stdin.write(bufferFromUnknown(payload?.buffer));
      return null;
    }
    case "plugin:shell|kill": {
      const child = shellProcesses.get(Number((args as { pid?: unknown } | undefined)?.pid))?.child;
      if (!child) throw new Error("unknown shell process");
      child.kill();
      return null;
    }
    case "plugin:store|load": {
      const storePath = (args as { path?: string } | undefined)?.path;
      if (!storePath) throw new Error("Missing store path");
      return loadStore(storePath);
    }
    case "plugin:store|get_store": {
      const storePath = (args as { path?: string } | undefined)?.path;
      if (!storePath) return null;
      const existing = [...stores.entries()].find(([, store]) => store.path === storePath);
      return existing?.[0] ?? null;
    }
    case "plugin:store|get": {
      const store = getStore((args as { rid?: unknown }).rid);
      const key = String((args as { key?: unknown }).key);
      if (!Object.hasOwn(store.data, key)) return [null, false];
      return [store.data[key], true];
    }
    case "plugin:store|set": {
      const store = getStore((args as { rid?: unknown }).rid);
      store.data[String((args as { key?: unknown }).key)] = (args as { value?: unknown }).value;
      store.dirty = true;
      return null;
    }
    case "plugin:store|save": {
      const store = getStore((args as { rid?: unknown }).rid);
      if (store.dirty) await writeJson(userDataPath("stores", store.path), store.data);
      store.dirty = false;
      return null;
    }
    case "plugin:store|has": {
      const store = getStore((args as { rid?: unknown }).rid);
      return Object.hasOwn(store.data, String((args as { key?: unknown }).key));
    }
    case "plugin:store|delete": {
      const store = getStore((args as { rid?: unknown }).rid);
      delete store.data[String((args as { key?: unknown }).key)];
      store.dirty = true;
      return null;
    }
    case "plugin:store|clear":
    case "plugin:store|reset": {
      const store = getStore((args as { rid?: unknown }).rid);
      store.data = {};
      store.dirty = true;
      return null;
    }
    case "plugin:store|keys":
      return Object.keys(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|values":
      return Object.values(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|entries":
      return Object.entries(getStore((args as { rid?: unknown }).rid).data);
    case "plugin:store|length":
      return Object.keys(getStore((args as { rid?: unknown }).rid).data).length;
    case "plugin:store|reload":
      return null;
    case "plugin:fs|create": {
      const file = pathFromFsArgs(args, options);
      return openFsFile(file, { write: true, create: true, truncate: true });
    }
    case "plugin:fs|open": {
      const file = pathFromFsArgs(args, options);
      return openFsFile(file, fsInvokeOptions(args, options));
    }
    case "plugin:fs|mkdir": {
      const file = pathFromFsArgs(args, options);
      const invokeOptions = fsInvokeOptions(args, options);
      await fs.mkdir(file, { recursive: invokeOptions.recursive !== false });
      return null;
    }
    case "plugin:fs|copy_file": {
      const fromPath = fsPathField(args, "fromPath");
      const toPath = fsPathField(args, "toPath");
      await fs.mkdir(path.dirname(toPath), { recursive: true });
      await fs.copyFile(fromPath, toPath);
      return null;
    }
    case "plugin:fs|read_dir": {
      const entries = await fs.readdir(pathFromFsArgs(args, options), {
        withFileTypes: true,
      });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymlink: entry.isSymbolicLink(),
      }));
    }
    case "plugin:fs|read_text_file":
      return Array.from(await fs.readFile(pathFromFsArgs(args, options)));
    case "plugin:fs|read_file":
      return Array.from(await fs.readFile(pathFromFsArgs(args, options)));
    case "plugin:fs|read_text_file_lines": {
      const file = pathFromFsArgs(args, options);
      const encoding = fsLineEncoding(args);
      const contents = await fs.readFile(file, { encoding });
      const lines = contents.split(/\r\n|\n|\r/);
      if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/.test(contents)) lines.pop();
      const rid = takeNextResourceId();
      fsResources.set(rid, { kind: "lines", encoding, index: 0, lines });
      return rid;
    }
    case "plugin:fs|read_text_file_lines_next": {
      const rid = (args as { rid?: unknown } | undefined)?.rid;
      const resource = fsResource(rid);
      if (resource.kind !== "lines") {
        throw new Error(`Filesystem rid is not a line iterator: ${String(rid)}`);
      }
      if (resource.index >= resource.lines.length) {
        if (typeof rid === "number") fsResources.delete(rid);
        return [1];
      }
      const encoded = Buffer.from(resource.lines[resource.index++], resource.encoding);
      return [...encoded, 0];
    }
    case "plugin:fs|read": {
      const resource = fsFileResource((args as { rid?: unknown } | undefined)?.rid);
      const len = Math.max(0, Number((args as { len?: unknown } | undefined)?.len ?? 0));
      const buffer = Buffer.alloc(len);
      const { bytesRead } = await resource.handle.read(buffer, 0, len, resource.position);
      resource.position += bytesRead;
      return bytesWithReadCount(buffer, bytesRead);
    }
    case "plugin:fs|remove": {
      const invokeOptions = fsInvokeOptions(args, options);
      await fs.rm(pathFromFsArgs(args, options), {
        recursive: invokeOptions.recursive === true,
        force: false,
      });
      return null;
    }
    case "plugin:fs|rename": {
      await fs.rename(fsPathField(args, "oldPath"), fsPathField(args, "newPath"));
      return null;
    }
    case "plugin:fs|stat":
      return fileInfoFromStats(await fs.stat(pathFromFsArgs(args, options)));
    case "plugin:fs|lstat":
      return fileInfoFromStats(await fs.lstat(pathFromFsArgs(args, options)));
    case "plugin:fs|fstat": {
      const resource = fsFileResource((args as { rid?: unknown } | undefined)?.rid);
      return fileInfoFromStats(await resource.handle.stat());
    }
    case "plugin:fs|truncate": {
      const len = Number(args && typeof args === "object" && "len" in args ? args.len : 0);
      await fs.truncate(pathFromFsArgs(args, options), Number.isFinite(len) ? len : 0);
      return null;
    }
    case "plugin:fs|ftruncate": {
      const resource = fsFileResource((args as { rid?: unknown } | undefined)?.rid);
      const len = Number((args as { len?: unknown } | undefined)?.len ?? 0);
      await resource.handle.truncate(Number.isFinite(len) ? len : 0);
      return null;
    }
    case "plugin:fs|seek": {
      const resource = fsFileResource((args as { rid?: unknown } | undefined)?.rid);
      const offset = Number((args as { offset?: unknown } | undefined)?.offset ?? 0);
      const whence = Number((args as { whence?: unknown } | undefined)?.whence ?? 0);
      const base =
        whence === 1 ? resource.position : whence === 2 ? (await resource.handle.stat()).size : 0;
      const nextPosition = base + offset;
      if (!Number.isFinite(nextPosition) || nextPosition < 0) {
        throw new Error("Invalid seek offset");
      }
      resource.position = nextPosition;
      return resource.position;
    }
    case "plugin:fs|write_text_file": {
      const file = pathFromFsArgs(args, options);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const bytes =
        args instanceof ArrayBuffer ? Buffer.from(args) : Buffer.from(args as Uint8Array);
      await fs.writeFile(file, bytes);
      return null;
    }
    case "plugin:fs|write_file": {
      const file = pathFromFsArgs(args, options);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const bytes =
        args instanceof ArrayBuffer ? Buffer.from(args) : Buffer.from(args as Uint8Array);
      await fs.writeFile(file, bytes);
      return null;
    }
    case "plugin:fs|write": {
      const resource = fsFileResource((args as { rid?: unknown } | undefined)?.rid);
      const data = bufferFromUnknown((args as { data?: unknown } | undefined)?.data);
      const { bytesWritten } = await resource.handle.write(
        data,
        0,
        data.length,
        resource.append ? null : resource.position,
      );
      resource.position = resource.append
        ? (await resource.handle.stat()).size
        : resource.position + bytesWritten;
      return bytesWritten;
    }
    case "plugin:fs|exists":
      return pathExists(pathFromFsArgs(args, options));
    case "plugin:fs|watch": {
      const payload = args as
        | {
            paths?: unknown;
            onEvent?: unknown;
            options?: { recursive?: boolean };
          }
        | undefined;
      const watchPaths = (Array.isArray(payload?.paths) ? payload.paths : [payload?.paths])
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeFsPath);
      const channelId = channelIdFrom(payload?.onEvent);
      const watchers = watchPaths.map((watchPath) => {
        const sendWatchEvent = (changedPath?: string | Buffer | null) => {
          const fullPath = changedPath ? path.join(watchPath, String(changedPath)) : watchPath;
          sendChannel(event.sender, channelId, {
            type: "any",
            paths: [fullPath],
            attrs: null,
          });
        };
        try {
          return watchFs(
            watchPath,
            { recursive: payload?.options?.recursive === true },
            (_type, changedPath) => {
              sendWatchEvent(changedPath);
            },
          );
        } catch {
          return watchFs(watchPath, (_type, changedPath) => {
            sendWatchEvent(changedPath);
          });
        }
      });
      const rid = takeNextResourceId();
      fsResources.set(rid, { kind: "watcher", watchers });
      return rid;
    }
    case "plugin:fs|size":
      return fsEntrySize(pathFromFsArgs(args, options));
    case "plugin:fs|start_accessing_security_scoped_resource":
    case "plugin:fs|stop_accessing_security_scoped_resource":
      return null;
    default:
      throw new Error(`Electron host command is not implemented yet: ${cmd}`);
  }
}

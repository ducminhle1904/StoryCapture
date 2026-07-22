import type { StartRecordingArgs } from "@storycapture/shared-types";
import { app } from "electron";
import { authorSession } from "./legacy/capture-preview";
import { legacyHandlers } from "./legacy-command";
import {
  acknowledgeStrictBrowserRecordingV3,
  probeStrictBrowserRecordingV3Capability,
  queryStrictBrowserRecordingV3,
  reattachStrictBrowserRecordingV3,
} from "./recording-strict-browser-lifecycle";
import type { InvokeHandlers } from "./types";

function startArgs(raw: unknown): StartRecordingArgs {
  const args = (raw as { args?: unknown } | null)?.args;
  if (!args || typeof args !== "object") throw new Error("recording args required");
  return args as StartRecordingArgs;
}

function authorPreviewUrl(args: StartRecordingArgs): string {
  if (args.target.kind !== "author_preview") return "";
  try {
    return authorSession(args.target.stream_id).window.webContents.getURL();
  } catch {
    return "";
  }
}

function recordingV3EnvironmentArgs(): StartRecordingArgs {
  return {
    project_folder: app.getPath("userData"),
    target: { kind: "author_preview", stream_id: "recording-v3-environment-probe" },
    width: 960,
    height: 540,
    fps: 60,
    contract_version: 3,
    enforcement_mode: "strict",
    certification_mode: "certified",
    delivery_policy: "strict",
    include_cursor: false,
    capture_contract: {
      version: 3,
      guarantee_boundary: "electron_offscreen_delivery",
      source_ordinal_kind: "electron_frame_count",
      target_class: "browser",
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
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    },
  };
}

export const recordingHandlers = {
  ...legacyHandlers([
    "start_recording",
    "electron_recording_set_audio",
    "stop_recording",
    "pause_recording",
    "resume_recording",
  ]),
  recording_v3_capability: async (raw) => {
    const args = startArgs(raw);
    return probeStrictBrowserRecordingV3Capability(args, authorPreviewUrl(args));
  },
  recording_v3_environment: () =>
    probeStrictBrowserRecordingV3Capability(recordingV3EnvironmentArgs(), ""),
  recording_v3_query: (raw) => {
    const projectFolder = String((raw as { projectFolder?: unknown } | null)?.projectFolder ?? "");
    if (!projectFolder) throw new Error("projectFolder required");
    return queryStrictBrowserRecordingV3(projectFolder);
  },
  recording_v3_reattach: (raw, context) => {
    const value = raw as { id?: unknown; onEvent?: unknown } | null;
    const id = String(value?.id ?? "");
    if (!id) throw new Error("recording session id required");
    return reattachStrictBrowserRecordingV3(id, context.event.sender, value?.onEvent);
  },
  recording_v3_ack: (raw) => {
    const id = String((raw as { id?: unknown } | null)?.id ?? "");
    if (!id) throw new Error("recording session id required");
    return acknowledgeStrictBrowserRecordingV3(id);
  },
} satisfies InvokeHandlers;

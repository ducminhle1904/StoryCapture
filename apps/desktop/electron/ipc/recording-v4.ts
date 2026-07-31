import path from "node:path";
import type { StartRecordingV4Args } from "@storycapture/shared-types";
import type { RecordingV4Command } from "@storycapture/shared-types/recording-v4";
import { app } from "electron";
import { recordingV4ChannelId } from "./recording-v4-channel";
import {
  type RecordingV4ActionInput,
  RecordingV4Coordinator,
  type RecordingV4PlatformSessionFactory,
} from "./recording-v4-coordinator";
import type { InvokeArgs, InvokeHandlers } from "./types";

const DEVELOPMENT_FLAG = "STORYCAPTURE_ENABLE_RECORDING_V4";

let platformSessionFactory: RecordingV4PlatformSessionFactory = () => {
  const error = new Error("Recording V4 native platform session is not configured.") as Error & {
    recordingV4FailureCode: "helper_unavailable";
  };
  error.recordingV4FailureCode = "helper_unavailable";
  throw error;
};
let coordinator: RecordingV4Coordinator | null = null;

export function isRecordingV4DevelopmentRouteEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env[DEVELOPMENT_FLAG] === "1";
}

function requireDevelopmentRoute(): void {
  if (!isRecordingV4DevelopmentRouteEnabled()) {
    throw new Error(
      `Recording V4 is development-only; set ${DEVELOPMENT_FLAG}=1 in a non-production build.`,
    );
  }
}

function currentCoordinator(): RecordingV4Coordinator {
  coordinator ??= new RecordingV4Coordinator({
    journalRoot: path.join(app.getPath("userData"), "recording-v4", "sessions"),
    platformSessionFactory,
  });
  return coordinator;
}

function objectArgs(args: InvokeArgs): Record<string, unknown> {
  if (
    !args ||
    typeof args !== "object" ||
    args instanceof ArrayBuffer ||
    args instanceof Uint8Array
  ) {
    throw new Error("Recording V4 IPC requires object arguments.");
  }
  return args;
}

function sessionId(value: unknown): string {
  if (!value || typeof value !== "object" || !("id" in value)) {
    throw new Error("Recording V4 IPC requires a session ID.");
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string" || !id) throw new Error("Recording V4 session ID is invalid.");
  return id;
}

function recordingCommand(value: unknown): RecordingV4Command {
  if (
    value !== "start" &&
    value !== "pause" &&
    value !== "resume" &&
    value !== "stop" &&
    value !== "cancel"
  ) {
    throw new Error("Recording V4 command is invalid.");
  }
  return value;
}

export function configureRecordingV4PlatformSessionFactory(
  factory: RecordingV4PlatformSessionFactory,
): void {
  if (coordinator) throw new Error("Recording V4 coordinator is already initialized.");
  platformSessionFactory = factory;
}

export async function initializeRecordingV4Ipc(): Promise<void> {
  if (!isRecordingV4DevelopmentRouteEnabled()) return;
  await currentCoordinator().initialize();
}

export const recordingV4Handlers = {
  recording_v4_start: async (args, context) => {
    requireDevelopmentRoute();
    const payload = objectArgs(args);
    const request = payload.args as StartRecordingV4Args | undefined;
    if (!request) throw new Error("Recording V4 start request is missing.");
    if (payload.onEvent !== undefined && recordingV4ChannelId(payload.onEvent) === null) {
      throw new Error("Recording V4 start subscription channel is invalid.");
    }
    const session = await currentCoordinator().create(request);
    const onEvent = payload.onEvent;
    if (onEvent !== undefined) {
      currentCoordinator().subscribe(session.id, context.event.sender, onEvent);
    }
    return session;
  },
  recording_v4_command: async (args) => {
    requireDevelopmentRoute();
    await currentCoordinator().initialize();
    const payload = objectArgs(args);
    return currentCoordinator().command(
      sessionId(payload.session),
      recordingCommand(payload.command),
    );
  },
  recording_v4_snapshot: async (args) => {
    requireDevelopmentRoute();
    await currentCoordinator().initialize();
    const payload = objectArgs(args);
    return currentCoordinator().snapshot(sessionId(payload.session));
  },
  recording_v4_subscribe: async (args, context) => {
    requireDevelopmentRoute();
    await currentCoordinator().initialize();
    const payload = objectArgs(args);
    return currentCoordinator().subscribe(
      sessionId(payload.session),
      context.event.sender,
      payload.onEvent,
    );
  },
  recording_v4_action: async (args) => {
    requireDevelopmentRoute();
    const payload = objectArgs(args);
    if (!payload.action || typeof payload.action !== "object") {
      throw new Error("Recording V4 action payload is missing.");
    }
    return currentCoordinator().recordAction(
      sessionId(payload.session),
      payload.action as RecordingV4ActionInput,
    );
  },
} satisfies InvokeHandlers;

import type { StartRecordingV4Args, RecordingV4SessionId } from "@storycapture/shared-types";
import type {
  RecordingV4Command,
  RecordingV4Event,
  RecordingV4Result,
  RecordingV4Snapshot,
} from "@storycapture/shared-types/recording-v4";
import { Channel, invoke } from "@tauri-apps/api/core";

const ACTIVE_SESSIONS_KEY = "storycapture.recording-v4.active-sessions";

export interface RecordingV4ActionIntent {
  step_id: string | null;
  ordinal: number;
  phase: string;
  payload?: Record<string, unknown>;
}

export interface RecordingV4ChannelHandle {
  onmessage: ((event: RecordingV4Event) => void) | null;
}

export interface RecordingV4Subscription {
  channel: RecordingV4ChannelHandle;
  snapshot?: RecordingV4Snapshot;
}

function eventChannel(onEvent: (event: RecordingV4Event) => void): Channel<RecordingV4Event> {
  const channel = new Channel<RecordingV4Event>();
  channel.onmessage = onEvent;
  return channel;
}

export async function createRecordingV4(
  args: StartRecordingV4Args,
  onEvent: (event: RecordingV4Event) => void,
): Promise<{ session: RecordingV4SessionId; channel: RecordingV4ChannelHandle }> {
  const channel = eventChannel(onEvent);
  const session = await invoke<RecordingV4SessionId>("recording_v4_start", { args, onEvent: channel });
  return { session, channel };
}

export function commandRecordingV4(
  session: RecordingV4SessionId,
  command: RecordingV4Command,
): Promise<RecordingV4Result | null> {
  return invoke("recording_v4_command", { session, command });
}

export function getRecordingV4Snapshot(
  session: RecordingV4SessionId,
): Promise<RecordingV4Snapshot> {
  return invoke("recording_v4_snapshot", { session });
}

export async function subscribeRecordingV4(
  session: RecordingV4SessionId,
  onEvent: (event: RecordingV4Event) => void,
): Promise<RecordingV4Subscription> {
  const channel = eventChannel(onEvent);
  const snapshot = await invoke<RecordingV4Snapshot>("recording_v4_subscribe", {
    session,
    onEvent: channel,
  });
  return { channel, snapshot };
}

export function recordRecordingV4Action(
  session: RecordingV4SessionId,
  action: RecordingV4ActionIntent,
): Promise<void> {
  return invoke("recording_v4_action", { session, action });
}

function readActiveSessions(storage: Storage): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(ACTIVE_SESSIONS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function rememberRecordingV4Session(
  projectPath: string,
  sessionId: string,
  storage: Storage = window.localStorage,
): void {
  const sessions = readActiveSessions(storage);
  sessions[projectPath] = sessionId;
  storage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessions));
}

export function recalledRecordingV4Session(
  projectPath: string,
  storage: Storage = window.localStorage,
): RecordingV4SessionId | null {
  const id = readActiveSessions(storage)[projectPath];
  return id ? { id } : null;
}

export function forgetRecordingV4Session(
  projectPath: string,
  expectedSessionId?: string,
  storage: Storage = window.localStorage,
): void {
  const sessions = readActiveSessions(storage);
  if (expectedSessionId && sessions[projectPath] !== expectedSessionId) return;
  delete sessions[projectPath];
  storage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessions));
}

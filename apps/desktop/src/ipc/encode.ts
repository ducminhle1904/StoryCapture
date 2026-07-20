/** Encoder / recording IPC wrappers. */

import type {
  EncodeResultDto,
  RecordingCompletedResult,
  RecordingEvent,
  RecordingSessionId,
  RecordingStopResult,
  StartRecordingArgs,
} from "@storycapture/shared-types";
import { Channel, invoke } from "@tauri-apps/api/core";

export type {
  EncodeResultDto,
  RecordingCompletedResult,
  RecordingEvent,
  RecordingSessionId,
  RecordingStopResult,
  StartRecordingArgs,
};

export interface RecordingLifecycleAck {
  status: "recording" | "paused";
}

export async function probeHwEncoders(): Promise<unknown> {
  return invoke("probe_hw_encoders");
}

export async function startRecording(
  args: StartRecordingArgs,
  onEvent: (e: RecordingEvent) => void,
): Promise<RecordingSessionId> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = (evt) => onEvent(evt);
  return invoke<RecordingSessionId>("start_recording", {
    args,
    onEvent: channel,
  });
}

export async function stopRecording(
  session: RecordingSessionId,
  onEvent: (e: RecordingEvent) => void = () => {},
): Promise<RecordingStopResult> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = (evt) => onEvent(evt);
  return invoke<RecordingStopResult>("stop_recording", {
    session,
    onEvent: channel,
  });
}

export async function pauseRecording(session: RecordingSessionId): Promise<RecordingLifecycleAck> {
  return invoke("pause_recording", { session });
}

export async function resumeRecording(session: RecordingSessionId): Promise<RecordingLifecycleAck> {
  return invoke("resume_recording", { session });
}

/** Encoder / recording IPC wrappers. */

import type {
  EncodeResultDto,
  RecordingCompletedResult,
  RecordingEvent,
  RecordingHostSessionSnapshotV3,
  RecordingPreflightV3Dto,
  RecordingV3DevelopmentEnvironmentDto,
  RecordingSessionId,
  RecordingStopResult,
  StartRecordingArgs,
} from "@storycapture/shared-types";
import { Channel, invoke } from "@tauri-apps/api/core";

export type {
  EncodeResultDto,
  RecordingCompletedResult,
  RecordingEvent,
  RecordingHostSessionSnapshotV3,
  RecordingPreflightV3Dto,
  RecordingV3DevelopmentEnvironmentDto,
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

export async function probeRecordingV3Capability(
  args: StartRecordingArgs,
): Promise<RecordingPreflightV3Dto> {
  return invoke("recording_v3_capability", { args });
}

export async function probeRecordingV3Environment(): Promise<RecordingPreflightV3Dto> {
  return invoke("recording_v3_environment");
}

export async function probeRecordingV3DevelopmentEnvironment(): Promise<RecordingV3DevelopmentEnvironmentDto> {
  return invoke("recording_v3_development_environment");
}

export async function queryRecordingV3Sessions(
  projectFolder: string,
): Promise<RecordingHostSessionSnapshotV3[]> {
  return invoke("recording_v3_query", { projectFolder });
}

export async function reattachRecordingV3(
  id: string,
  onEvent: (event: RecordingEvent) => void,
): Promise<RecordingHostSessionSnapshotV3 | null> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = onEvent;
  return invoke("recording_v3_reattach", { id, onEvent: channel });
}

export async function acknowledgeRecordingV3(id: string): Promise<boolean> {
  return invoke("recording_v3_ack", { id });
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

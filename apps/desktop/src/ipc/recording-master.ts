import { invoke } from "@tauri-apps/api/core";

export interface RecordingMasterDecoderHandle {
  id: string;
}

export function openRecordingMasterDecoder(args: {
  path: string;
  width: number;
  height: number;
}): Promise<RecordingMasterDecoderHandle> {
  return invoke("open_recording_master_decoder", { args });
}

export function decodeRecordingMasterFrame(
  handle: RecordingMasterDecoderHandle,
  frameIndex: number,
): Promise<Uint8Array> {
  return invoke("decode_recording_master_frame", {
    args: { id: handle.id, frame_index: frameIndex },
  });
}

export function closeRecordingMasterDecoder(handle: RecordingMasterDecoderHandle): Promise<void> {
  return invoke("close_recording_master_decoder", { args: { id: handle.id } });
}

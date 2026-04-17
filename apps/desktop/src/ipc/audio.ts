/**
 * Audio IPC wrappers (Phase 6 plan 01). See
 * `apps/desktop/src-tauri/src/commands/audio.rs`.
 *
 * Laziness contract: `listAudioInputs` is called ONLY when the
 * AudioDevicePicker first opens. Don't prefetch on app launch —
 * cpal's default-device resolution touches the mic hardware on macOS
 * and triggers the TCC prompt (cpal#901).
 */

import { invoke } from "@tauri-apps/api/core";

export interface AudioInputInfo {
  id: string;
  name: string;
  is_default: boolean;
  channels: number;
  sample_rate_hz: number;
}

export function listAudioInputs(): Promise<AudioInputInfo[]> {
  return invoke<AudioInputInfo[]>("list_audio_inputs");
}

/** Sentinel for the "System default" option in the picker. When this
 *  is selected the renderer passes `"default"` to the host, which
 *  resolves to cpal's `default_input_device` at capture-start. */
export const AUDIO_DEFAULT_SENTINEL = "default";

/** Picker option used when the user wants no audio. UI value is null;
 *  mapped to `undefined` in the start_recording payload (absent field
 *  → silent track, Phase 1 behavior). */
export type AudioPickerValue = string | null;

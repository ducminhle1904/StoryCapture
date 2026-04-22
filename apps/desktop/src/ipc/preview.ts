/**
 * Phase 09-02 — live preview IPC wrappers.
 *
 * Routes to the pump task in `apps/desktop/src-tauri/src/commands/automation.rs`
 * which drains the 09-01 `watch::Receiver<Option<PreviewFrame>>` and emits a
 * Tauri `preview://frame` event per payload. Payload shape mirrors
 * `automation::PreviewFrame` (base64 JPEG + dims + timestamp).
 */

import { invoke } from "@tauri-apps/api/core";

export interface PreviewFramePayload {
  data: string;
  width: number;
  height: number;
  timestamp: number;
}

export async function startPreviewStream(): Promise<void> {
  await invoke("start_preview_stream");
}

export async function stopPreviewStream(): Promise<void> {
  await invoke("stop_preview_stream");
}

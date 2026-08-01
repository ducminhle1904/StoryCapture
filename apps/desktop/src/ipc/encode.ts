/** Encoder capability IPC wrapper used by export settings. */

import { invoke } from "@tauri-apps/api/core";

export async function probeHwEncoders(): Promise<unknown> {
  return invoke("probe_hw_encoders");
}

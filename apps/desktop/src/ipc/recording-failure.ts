import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

export function openRecordingDiagnosticBundle(bundlePath: string): Promise<void> {
  return open(bundlePath);
}

export function deleteFailedRecordingBundle(
  projectFolder: string,
  bundlePath: string,
): Promise<void> {
  return invoke("recording_delete_failed_bundle", {
    args: { project_folder: projectFolder, bundle_path: bundlePath },
  });
}

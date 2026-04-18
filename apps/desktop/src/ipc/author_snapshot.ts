/**
 * Author-time selector validator IPC wrappers (Plan 07-05).
 *
 * Thin facade over the Tauri commands defined in
 * `apps/desktop/src-tauri/src/commands/author_snapshot.rs`.
 *
 * The author-time flow is READ-ONLY by default — validation loads the
 * cached `.story.snapshots/<sha>.html` file and runs the Rust-side
 * `SmartSelector::validate_against_dom`. Capture is the only mutating
 * verb and requires an active Playwright sidecar (normally started
 * by `launch_automation` for the recording session).
 */

import { invoke } from "@tauri-apps/api/core";

export interface AuthorSnapshotEntry {
  url: string;
  domHash: string;
  capturedAt: string;
  screenshotPath: string;
  htmlPath: string;
}

/**
 * Typed union mirroring the Rust `AuthorValidationDto`. `status` is the
 * discriminator; `no_snapshot` is a first-class outcome that the UI
 * renders as the GREY chip with "Capture snapshot" affordance.
 */
export type AuthorValidation =
  | { status: "unique"; strategy: string }
  | { status: "fuzzy"; count: number; reason: string }
  | { status: "none" }
  | { status: "no_snapshot" };

/**
 * Request a fresh snapshot for `url`. Requires the Playwright sidecar
 * to be launched — throws when no session is active.
 */
export function authorSnapshotCapture(
  projectDir: string,
  url: string,
): Promise<AuthorSnapshotEntry> {
  return invoke<AuthorSnapshotEntry>("author_snapshot_capture", {
    projectDir,
    url,
  });
}

/** Return the manifest entry for `url`, or `null` when missing. */
export async function authorSnapshotGet(
  projectDir: string,
  url: string,
): Promise<AuthorSnapshotEntry | null> {
  const r = await invoke<AuthorSnapshotEntry | null>("author_snapshot_get", {
    projectDir,
    url,
  });
  return r;
}

export function authorSnapshotList(
  projectDir: string,
): Promise<AuthorSnapshotEntry[]> {
  return invoke<AuthorSnapshotEntry[]>("author_snapshot_list", { projectDir });
}

/**
 * Validate a parsed DSL target against the cached snapshot DOM. Pass the
 * target as a JSON-stringified `SelectorOrText` envelope — the Tauri
 * command parses it server-side.
 *
 * The JSON-envelope pattern mirrors `pickerStampStepId` (specta rejects
 * `serde_json::Value` as a function arg).
 */
export function authorSnapshotValidate(
  projectDir: string,
  url: string,
  target: unknown,
): Promise<AuthorValidation> {
  return invoke<AuthorValidation>("author_snapshot_validate", {
    projectDir,
    url,
    targetJson: JSON.stringify(target),
  });
}

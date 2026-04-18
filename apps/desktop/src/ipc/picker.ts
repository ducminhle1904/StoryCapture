/**
 * Element-picker IPC wrappers (Plan 07-03b).
 *
 * Thin typed facade for the `picker_*` Tauri commands defined in
 * `apps/desktop/src-tauri/src/commands/picker.rs`. Routes to the
 * Playwright sidecar's `pickElement.{start,cancel,isActive}` JSON-RPC
 * (07-03a wire contract).
 *
 * Wire contract — `result.emitted` (a single DSL line, no trailing
 * newline) — matches `scripts/playwright-sidecar/server.mjs:414`. The
 * caller (PickElementButton) appends `"\n"` and inserts at cursor.
 */

import { invoke } from "@tauri-apps/api/core";

export type PickLocator = {
  kind: "testid" | "role" | "label" | "text_exact" | "selector" | string;
  value: string | { role: string; name: string };
};

export type PickCandidate = {
  kind: string;
  value: unknown;
  score: number;
  unique: boolean;
};

export type PickPicked = {
  /** Single DSL line ready to insert at cursor (NO trailing newline). */
  emitted: string;
  locator: PickLocator;
  candidates: PickCandidate[];
};

export type PickCancelled = {
  cancelled: true;
  reason: "user-cancel" | "navigation" | "timeout" | "unsupported-url" | string;
};

export type PickResult = PickPicked | PickCancelled;

/** Type guard for the "successfully picked" arm. */
export function isPicked(r: PickResult): r is PickPicked {
  return "emitted" in r && typeof (r as PickPicked).emitted === "string";
}

/**
 * Internal envelope: the host wraps `automation::PickElementResponse`
 * as JSON-string (D-07 keeps the automation crate free of Tauri /
 * specta deps). We parse here and project onto the typed union.
 */
interface PickerStartDto {
  json: string;
}

/**
 * Start an element-picker session. Resolves on the first user click,
 * Esc, mid-pick navigation, unsupported-URL, or timeout.
 */
export async function pickElement(
  opts: { timeoutMs?: number } = {},
): Promise<PickResult> {
  const dto = await invoke<PickerStartDto>("picker_start", {
    timeoutMs: opts.timeoutMs ?? 60000,
  });
  // The Rust enum is `#[serde(untagged)]` so the inner JSON shape IS
  // the typed union — no DTO-to-domain mapping required.
  return JSON.parse(dto.json) as PickResult;
}

/** Cancel any in-flight pickElement session (idempotent). */
export async function pickElementCancel(): Promise<void> {
  await invoke("picker_cancel");
}

/** True iff a pickElement session is waiting for a click. */
export async function pickElementIsActive(): Promise<boolean> {
  return await invoke<boolean>("picker_is_active");
}

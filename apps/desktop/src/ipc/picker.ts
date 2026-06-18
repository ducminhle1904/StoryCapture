/**
 * Element-picker IPC wrappers.
 *
 * Thin typed facade for the `picker_*` host commands.
 *
 * Wire contract — `result.emitted` is a single DSL line with NO trailing
 * newline. The caller (PickElementButton) appends `"\n"` and inserts at
 * cursor.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PickLocator = {
  kind: "testid" | "role" | "label" | "text_exact" | "selector" | string;
  value: string | { role: string; name: string };
  /**
   * 1-indexed position when the picker's primary tier had count > 1 and the
   * user's clicked element was inside that ranked match list. Omitted on
   * unique tiers or legacy responses (Phases prior to D).
   */
  nth?: number;
};

export type PickCandidate = {
  kind: string;
  value: unknown;
  score: number;
  unique: boolean;
  /** Same semantics as `PickLocator.nth` — see above. */
  nth?: number;
};

/**
 * Element-shape metadata forwarded by the sidecar overlay. Optional —
 * legacy responses (sidecars without overlay metadata, or any locator
 * path that didn't capture an element) omit it. Used by the desktop
 * picker action menu to promote input-flavored actions
 * (fill/type/select/upload) without re-deriving DOM shape on the host.
 */
export type PickElementMeta = {
  tagName?: string;
  role?: string;
  accessibleName?: string;
  inputType?: string;
  isContentEditable?: boolean;
  isTextInput?: boolean;
  isSelect?: boolean;
  isFileInput?: boolean;
  optionLabels?: string[];
};

export type PickPicked = {
  /** Single DSL line ready to insert at cursor (NO trailing newline). */
  emitted: string;
  locator: PickLocator;
  candidates: PickCandidate[];
  element?: PickElementMeta;
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
 * as a JSON-string (keeps the automation crate free of Tauri / specta
 * deps). We parse here and project onto the typed union.
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

/**
 * live hover-preview payload emitted by the sidecar
 * overlay (rAF-throttled, ~60 Hz ceiling). The Rust forwarder task
 * translates each `pickElement.hoverPreview` notification into a Tauri
 * event of the same name (`picker_hover_preview`).
 *
 * Payload is intentionally lightweight — the full ranked DSL emission
 * still happens on click via `pickElement` (above). The chip only needs
 * enough to tell the user "this is what you're pointing at".
 */
export interface PickHoverPayload {
  testId?: string;
  role?: string;
  accessibleName?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
}

/**
 * Subscribe to live hover-preview events while a pick session is
 * active. Callers MUST invoke the returned unlisten fn when picking
 * ends or when the component unmounts.
 */
export async function listenPickerHoverPreview(
  cb: (p: PickHoverPayload) => void,
): Promise<UnlistenFn> {
  return await listen<PickHoverPayload>("picker_hover_preview", (evt) =>
    cb(evt.payload),
  );
}

/**
 * Stamp a UUIDv7 step id onto the picked `.story` line AND seed the
 * sibling `.story.targets.json` with the pick's primary + fallback
 * locators. Fire-and-forget from the UI: failures are toasted but do
 * NOT block the insertion flow (the editor already has the text at the
 * cursor by the time this is invoked).
 *
 * `primary` / `fallbacks` are typed `TargetRecordDto` discriminated
 * unions. Each record's `value` is `string` for most kinds and
 * `{ role, name }` for the `role` kind — matching the
 * `.story.targets.json` schema byte-for-byte.
 *
 * Returns the stamped UUIDv7 on success. Idempotent — re-picking an
 * already-stamped line returns the existing id without regenerating it.
 */
export type TargetRecordDto =
  | { kind: "testid"; value: string; nth?: number }
  | { kind: "role"; value: { role: string; name: string }; nth?: number }
  | { kind: "label"; value: string; nth?: number }
  | { kind: "text_exact"; value: string; nth?: number }
  | { kind: "selector"; value: string; nth?: number }
  | { kind: "aria"; value: string; nth?: number }
  | { kind: "text"; value: string; nth?: number };

export interface PickerStampStepIdArgs {
  /** Absolute path of the open `.story` file on disk. */
  storyPath: string;
  /** 1-indexed line number where the picked DSL sits. */
  lineOffset: number;
  /** The picked element's primary locator (mirrors sidecar result.locator). */
  primary: TargetRecordDto;
  /**
   * Full ranked fallback candidate list from the sidecar
   * (`result.candidates`), mapped to `{ kind, value }` tuples. Score /
   * unique fields are dropped — the targets sidecar keeps only the
   * locator identity.
   */
  fallbacks: TargetRecordDto[];
}

/**
 * Result shape for `pickerStampStepId`. Mirrors
 * `picker::PickerStampResultDto`.
 *
 * - `stepId`: the stamped UUIDv7 (existing-or-new) as a hyphenated string.
 * - `wasFreshlyStamped`: true iff this call minted a fresh @id and rewrote
 *   the .story source; false iff the line already carried `# @id=<uuid>`
 *   and the call was a targets.json-only re-seed.
 */
export interface PickerStampResult {
  stepId: string;
  wasFreshlyStamped: boolean;
}

interface PickerStampResultDto {
  step_id: string;
  was_freshly_stamped: boolean;
}

export async function pickerStampStepId(
  args: PickerStampStepIdArgs,
): Promise<PickerStampResult> {
  const dto = await invoke<PickerStampResultDto>("picker_stamp_step_id", {
    storyPath: args.storyPath,
    lineOffset: args.lineOffset,
    primary: args.primary,
    fallbacks: args.fallbacks,
  });
  return {
    stepId: dto.step_id,
    wasFreshlyStamped: dto.was_freshly_stamped,
  };
}

/**
 * Start a Preview-panel Pick against an author-session.
 *
 * Mirrors the shape of {@link pickElement} but routes through the
 * author-session keyed by `streamId`. The host:
 *   (1) replays `navigate` verbs from the story source up to cursor line
 *       to warm the author browser,
 *   (2) pauses the author screencast,
 *   (3) activates the picker overlay on the author page,
 *   (4) resumes the screencast on resolve/cancel.
 *
 * `storySrc` is the .story file contents as seen by the renderer. Callers
 * MUST warn the user about unsaved changes before invocation; this
 * wrapper sends the bytes as-is.
 */
export async function pickElementAuthor(opts: {
  streamId: string;
  storySrc: string;
  cursorLine: number;
  timeoutMs?: number;
}): Promise<PickResult> {
  const dto = await invoke<PickerStartDto>("picker_start_author", {
    streamId: opts.streamId,
    storySrc: opts.storySrc,
    cursorLine: opts.cursorLine,
    timeoutMs: opts.timeoutMs ?? 60000,
  });
  // Same JSON-envelope contract as pickElement — the untagged enum IS the
  // typed union, no DTO-to-domain mapping required.
  return JSON.parse(dto.json) as PickResult;
}

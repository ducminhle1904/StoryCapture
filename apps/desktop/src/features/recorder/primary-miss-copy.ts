/**
 * Single source of truth for the record-path PrimaryMissNoHeal error copy.
 * The Rust variant's thiserror Display string in
 * `crates/automation/src/error.rs` MUST stay in lock-step with the
 * constants below. `RECORD_PATH_MISS_BODY` is duplicated into the HUD
 * block and the Sonner toast so they never drift.
 */

/**
 * Phrase used to discriminate a `PrimaryMissNoHeal` StepFailed event
 * from generic selector failures. Substring-matching `error_message`
 * against this constant is sufficient because the Rust Display string
 * embeds it verbatim (checked by `crates/automation` tests).
 */
export const RECORD_PATH_MISS_MARKER = "Self-healing is disabled during recording";

/**
 * Body sentence rendered in the HUD block and mirrored in the Sonner
 * destructive toast — a single constant prevents drift.
 */
export const RECORD_PATH_MISS_BODY =
  "Self-healing is disabled during recording. Open this story in Simulator, use \"Promote to fallback\" on step {N}, then try again.";

/**
 * Parse a `StepFailed.error_message` that matches `PrimaryMissNoHeal`.
 * Extracts the verb excerpt (e.g. `click "Save"`) so the HUD can
 * render it inside the mono pill in the heading.
 *
 * Returns `null` when the message is NOT a PrimaryMissNoHeal error —
 * callers should fall back to their existing generic StepFailed path.
 */
export function parsePrimaryMiss(
  errorMessage: string,
): { verbExcerpt: string } | null {
  if (!errorMessage.includes(RECORD_PATH_MISS_MARKER)) return null;
  // Display string starts with `Step {N}: "{verb}" could not ...`
  // Extract the quoted verb excerpt for the heading mono pill.
  const m = /^Step \d+: "([^"]+)" could not match/.exec(errorMessage);
  return { verbExcerpt: m?.[1] ?? "" };
}

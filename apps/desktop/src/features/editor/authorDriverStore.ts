/**
 * authorDriverStore — Zustand projection of the host's AuthorDriverState
 * (see `apps/desktop/src-tauri/src/author_driver.rs` — D-16 FSM).
 *
 * READ-ONLY PROJECTION (per 11-RESEARCH §Q2 + 11-PATTERNS Pattern B):
 * the host FSM in the AuthorDriverRegistry remains the single source of
 * truth for admission control. This store is a *UI enablement hint* only:
 *   - disables the Pick button during `simulator-running` so users don't
 *     fire impossible requests;
 *   - flips the tooltip string across the five UI-SPEC states;
 *   - supplies the `{N}` paused ordinal and `streamId` the button needs
 *     to dispatch `pickElementAuthor`.
 *
 * Feeding mechanism (documented choice): DERIVED from
 * `useEditorLivePreview` (for `streamId`) and `useSimulatorStore`
 * (for `simulator-running`/`simulator-paused` + paused ordinal). Phase
 * 11-01 did NOT ship an `author_driver_state` event bridge — the host
 * FSM is updated from inside `picker_start_author_impl`, not emitted.
 * The renderer therefore reconstructs a compatible projection from the
 * two stores that already exist. If/when a future plan emits a
 * `listen('author_driver_state', …)` channel, `setSnapshot` is the one
 * seam to rewire.
 *
 * IMPORTANT: `variant === "picking"` is tracked via a manual `setPicking`
 * call from PreviewPickerButton's own onClick, because the Picking
 * transition also happens host-side inside picker_start_author_impl and
 * is not broadcast back. Two-way coherence is advisory; host gates are
 * the access-control authority.
 */

import { create } from "zustand";

export type AuthorDriverVariant =
  | "idle"
  | "live-preview"
  | "picking"
  | "simulator-running"
  | "simulator-paused";

export interface AuthorDriverStore {
  variant: AuthorDriverVariant;
  streamId: string | null;
  /** 1-indexed ordinal of the paused simulator step, or null. Used by
   *  the `simulator-paused` tooltip copy `Paused at step {N} — …`. */
  simulatorOrdinal: number | null;
  setSnapshot: (snapshot: Partial<AuthorDriverSnapshot>) => void;
}

export interface AuthorDriverSnapshot {
  variant: AuthorDriverVariant;
  streamId: string | null;
  simulatorOrdinal: number | null;
}

export const useAuthorDriverStore = create<AuthorDriverStore>((set) => ({
  variant: "idle",
  streamId: null,
  simulatorOrdinal: null,
  setSnapshot: (snapshot) => set(snapshot),
}));

/**
 * Map a pair of upstream facts (preview streamId + simulator run state)
 * onto the 5-variant AuthorDriverVariant enum.
 *
 * Precedence (per D-13/D-14/D-15/D-16):
 *   1. simulator running -> `simulator-running` (regardless of streamId)
 *   2. simulator paused  -> `simulator-paused`
 *   3. streamId present  -> `live-preview`
 *   4. otherwise         -> `idle`
 *
 * The host FSM may simultaneously be in `Picking` (after begin_pick);
 * the renderer overlays that manually via `setPicking(true)` in the
 * PreviewPickerButton onClick, which takes precedence over this
 * derivation for the duration of the pick.
 */
export function deriveVariant(
  streamId: string | null,
  simulatorRunState: "idle" | "running" | "paused" | "complete" | "failed" | "cancelled",
): AuthorDriverVariant {
  if (simulatorRunState === "running") return "simulator-running";
  if (simulatorRunState === "paused") return "simulator-paused";
  if (streamId) return "live-preview";
  return "idle";
}

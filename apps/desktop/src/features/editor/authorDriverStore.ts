/**
 * authorDriverStore — Zustand projection of the Electron host author state.
 *
 * Read-only projection: the host FSM is the single source of truth for
 * admission control. This store is a UI
 * enablement hint — it disables the Pick button during simulator-running,
 * flips the tooltip string per state, and supplies the paused ordinal +
 * streamId the button uses to dispatch `pickElementAuthor`.
 *
 * Derived from `useEditorLivePreview` (streamId) and `useSimulatorStore`
 * (sim run state + paused ordinal). There is no `author_driver_state`
 * event bridge yet — host transitions happen inside
 * `picker_start_author_impl` and are not broadcast back, so the renderer
 * reconstructs a compatible projection. `setSnapshot` is the one seam
 * to rewire if a host-side event channel ever ships.
 *
 * `variant === "picking"` is tracked via a manual override from the
 * button's own onClick because that transition is also host-side and not
 * broadcast. Two-way coherence is advisory; the host gates remain the
 * access-control authority.
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
   *  the `simulator-paused` tooltip. */
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
 * Precedence:
 *   1. simulator running -> `simulator-running` (regardless of streamId)
 *   2. simulator paused  -> `simulator-paused`
 *   3. streamId present  -> `live-preview`
 *   4. otherwise         -> `idle`
 *
 * The host FSM may simultaneously be in `Picking`; the button's onClick
 * overlays that manually for the duration of the pick.
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

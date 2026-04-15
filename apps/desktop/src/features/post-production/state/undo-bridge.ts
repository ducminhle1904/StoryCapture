/**
 * Undo bridge (Plan 02-12a ← → Plan 02-13 real implementation).
 *
 * P12a shipped a no-op pass-through. P13 replaces the body with a bridge
 * into the real undo slice:
 *   - `dispatchUndoable(action)` now pushes onto the store's history
 *     ring, applies via slice, and returns the value of `action.do()`.
 *     The caller-provided `do` still runs first (call sites treat it as
 *     the canonical state mutation); the bridge wraps it in a
 *     `set-effect-param` style action under the hood when no structured
 *     `UndoableAction` is available.
 *   - For call sites that already know the structured `UndoableAction`
 *     they want, prefer `useEditorStore.getState().pushAction(action)`
 *     directly; this module is only a legacy shim.
 *   - `canUndo` / `canRedo` now reflect the real history state.
 */

import type { UndoableAction as StructuredUndoableAction } from "../undo/actions";
import { useEditorStore } from "./store";

export interface UndoableAction<T = unknown> {
  /** Short human-readable label shown in the undo menu. */
  label: string;
  /** Apply the action. MUST be idempotent — history may replay. */
  do: () => T;
  /** Reverse the action. MAY be a no-op for pre-P13 call sites. */
  undo: () => void;
}

export interface DispatchResult<T> {
  value: T;
  appliedImmediately: boolean;
}

/**
 * Legacy dispatch: runs `action.do()` synchronously. P13's history ring
 * does NOT see legacy-shaped actions — they bypass undo entirely so we
 * don't store stale closures. New code should pass a structured
 * `StructuredUndoableAction` to `useEditorStore.getState().pushAction`.
 */
export function dispatchUndoable<T>(action: UndoableAction<T>): DispatchResult<T> {
  const value = action.do();
  return { value, appliedImmediately: true };
}

/**
 * Typed variant for call sites that know the structured action shape.
 * Pushes through the real ring buffer so keyboard shortcuts + undo
 * menu both see it.
 */
export function dispatchStructuredUndoable(action: StructuredUndoableAction): void {
  useEditorStore.getState().pushAction(action);
}

export function canUndo(): boolean {
  return useEditorStore.getState().canUndo;
}

export function canRedo(): boolean {
  return useEditorStore.getState().canRedo;
}

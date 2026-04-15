/**
 * Undo bridge (Plan 02-12a ← → Plan 02-13 placeholder).
 *
 * P12a ships the bridge *interface* so P12b UI code can wrap its mutations
 * in `dispatchUndoable(action)` without depending on the as-yet-unbuilt
 * history buffer. P13 will replace the body with a real history-ring
 * integration; until then this is a thin pass-through that immediately
 * invokes the action's `do()` — no undo, no redo.
 *
 * Consumers should treat the return value as opaque. The shape (label +
 * do/undo callbacks) is stable; P13 adds batching + redo without
 * breaking the call sites this plan enables.
 */

export interface UndoableAction<T = unknown> {
  /** Short human-readable label shown in the undo menu. */
  label: string;
  /** Apply the action. MUST be idempotent — P13's history may replay. */
  do: () => T;
  /** Reverse the action. MAY be a no-op while P13 is pending. */
  undo: () => void;
}

export interface DispatchResult<T> {
  /** Return value from `action.do()`. */
  value: T;
  /** Always true in P12a (no history). P13 may gate behaviour off this. */
  appliedImmediately: boolean;
}

/**
 * P12a no-op implementation. Invokes `action.do()` synchronously and
 * returns its value. P13 replaces this with a function that pushes onto
 * the history buffer before dispatching.
 */
export function dispatchUndoable<T>(action: UndoableAction<T>): DispatchResult<T> {
  const value = action.do();
  return { value, appliedImmediately: true };
}

/**
 * Stub: in P12a nothing is undoable yet, so this always returns false.
 * P13 replaces with real history-state queries.
 */
export function canUndo(): boolean {
  return false;
}

/** Same idea as {@link canUndo}. */
export function canRedo(): boolean {
  return false;
}

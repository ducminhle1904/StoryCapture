/**
 * Re-export hook (Plan 02-12b).
 *
 * Gives editor UI a single import path for the Zustand store living at
 * `state/store.ts`. Plan 13 (undo buffer) may add memoised selectors
 * here; for now it is a transparent re-export.
 */

export { useEditorStore } from "../state/store";
export type { EditorStore } from "../state/store";

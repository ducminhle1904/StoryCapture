/**
 * `useUndoRedo` — reactive bindings for the undo slice + keyboard
 * shortcuts.
 *
 *   Cmd/Ctrl+Z       → undo
 *   Cmd/Ctrl+Shift+Z → redo (macOS convention)
 *   Cmd/Ctrl+Y       → redo (Windows convention)
 *
 * The `mod+` alias in react-hotkeys-hook resolves to Cmd on macOS and
 * Ctrl on Windows/Linux, so `mod+z` covers both platforms' undo keys
 * with a single registration.
 */

import { useHotkeys } from "react-hotkeys-hook";

import { useEditorStore } from "../state/store";

export interface UndoRedoApi {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useUndoRedo(): UndoRedoApi {
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);

  useHotkeys(
    "mod+z",
    (e) => {
      e.preventDefault();
      undo();
    },
    { preventDefault: true, enableOnContentEditable: false },
    [undo],
  );
  useHotkeys(
    "mod+shift+z, mod+y",
    (e) => {
      e.preventDefault();
      redo();
    },
    { preventDefault: true, enableOnContentEditable: false },
    [redo],
  );

  return { undo, redo, canUndo, canRedo };
}

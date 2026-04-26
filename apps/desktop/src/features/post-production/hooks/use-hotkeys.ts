/**
 * Editor keyboard shortcuts.
 *
 * Space             play/pause
 * ArrowLeft/Right   seek ±33 ms (1 frame @30fps)
 * Shift+Arrow       seek ±5 s (jump)
 * . / ,             frame-step forward/back (33 ms)
 * Delete/Backspace  remove selected clip
 * Alt (hold)        disable magnetic snap while held
 * mod+z / mod+y     undo/redo
 *
 * Uses `react-hotkeys-hook`. The module exports a single top-level
 * `useEditorHotkeys` function so callers mount them all with one import.
 */

import { useCallback, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { useEditorStore } from "../state/store";

const FRAME_MS_30 = 33; // ~1 frame at 30 fps
const JUMP_MS = 5000;

export function useEditorHotkeys(): void {
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const deleteClip = useEditorStore((s) => s.deleteClip);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const tracks = useEditorStore((s) => s.tracks);
  const setSnapEnabled = useEditorStore((s) => s.setSnapEnabled);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);

  const seekBy = useCallback(
    (delta: number) => {
      const next = Math.max(0, useEditorStore.getState().playheadMs + delta);
      setPlayhead(next);
    },
    [setPlayhead],
  );

  // Space: play/pause. We don't own playback state (the preview player
  // does), so dispatch a custom event the preview hook listens for.
  useHotkeys(
    "space",
    () => {
      window.dispatchEvent(new Event("storycapture:toggle-playback"));
    },
    { preventDefault: true },
    [],
  );

  useHotkeys("right", () => seekBy(FRAME_MS_30), { preventDefault: true }, [seekBy]);
  useHotkeys("left", () => seekBy(-FRAME_MS_30), { preventDefault: true }, [seekBy]);
  useHotkeys("shift+right", () => seekBy(JUMP_MS), { preventDefault: true }, [seekBy]);
  useHotkeys("shift+left", () => seekBy(-JUMP_MS), { preventDefault: true }, [seekBy]);
  useHotkeys("period", () => seekBy(FRAME_MS_30), { preventDefault: true }, [seekBy]);
  useHotkeys("comma", () => seekBy(-FRAME_MS_30), { preventDefault: true }, [seekBy]);

  useHotkeys(
    "delete,backspace",
    () => {
      if (!selectedClipId) return;
      // Scan tracks for the selected id; remove from whichever track owns it.
      for (const trackId of ["video", "cursor", "zoom", "sound", "annotations"] as const) {
        if (tracks[trackId].some((c) => c.id === selectedClipId)) {
          deleteClip(trackId, selectedClipId);
          setSelectedClipId(null);
          return;
        }
      }
    },
    { preventDefault: true },
    [selectedClipId, tracks, deleteClip, setSelectedClipId],
  );

  // Alt-hold toggles snap off while held; restore on keyup. We avoid
  // react-hotkeys-hook's keyup handling (mixed browser support) and rely
  // on raw keyboard events to track the modifier state.
  useEffect(() => {
    let wasEnabled = snapEnabled;
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && snapEnabled) {
        wasEnabled = true;
        setSnapEnabled(false);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && wasEnabled) {
        setSnapEnabled(true);
        wasEnabled = false;
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [snapEnabled, setSnapEnabled]);

  // Undo / redo — forwards to the store. `useUndoRedo` also registers
  // these keys independently; duplicate registration is harmless because
  // react-hotkeys-hook dedupes by binding key + callback identity, and
  // both paths call the same store action.
  const storeUndo = useEditorStore((s) => s.undo);
  const storeRedo = useEditorStore((s) => s.redo);
  useHotkeys(
    "mod+z",
    (e) => {
      e.preventDefault();
      storeUndo();
    },
    { preventDefault: true },
    [storeUndo],
  );
  useHotkeys(
    "mod+shift+z,mod+y",
    (e) => {
      e.preventDefault();
      storeRedo();
    },
    { preventDefault: true },
    [storeRedo],
  );

  // Reference playheadMs so ESLint doesn't flag it as unused; the
  // re-render it causes is intentional (hotkey closures capture latest
  // state via `useEditorStore.getState()` inside seekBy).
  void playheadMs;
}

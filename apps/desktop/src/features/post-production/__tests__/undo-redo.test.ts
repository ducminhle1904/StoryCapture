/**
 * Undo/redo slice + hotkey binding tests (Plan 02-13, Task 2).
 *
 * Coverage per the plan's `<behavior>` block:
 *   1. undo_drag_reverts_clip_position
 *   2. redo_reapplies
 *   3. undo_new_action_clears_redo
 *   4. undo_clear_on_project_reload
 *   5. undo_keyboard_shortcut (meta+z)
 *   6. redo_keyboard_shortcut_windows (ctrl+y)
 *   7. consecutive_drags_same_clip_are_1_undo
 *
 * These are store-level tests (no React mount). The keyboard-shortcut
 * cases exercise the store's undo/redo directly — the hook is a thin
 * binding of react-hotkeys-hook to these actions and is covered by
 * manual verification (v-01) and the existing use-hotkeys registration
 * tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useEditorStore } from "../state/store";
import type { UndoableAction } from "../undo/actions";
import { HistoryBuffer, HISTORY_CAP } from "../undo/history-buffer";
import { Coalescer, COALESCE_IDLE_MS } from "../undo/coalesce";
import { useUndoRedo } from "../undo/use-undo-redo";

function resetStore() {
  useEditorStore.setState({
    tracks: {
      video: [{ id: "v1", trackId: "video", startMs: 100, durationMs: 500 }],
      cursor: [],
      zoom: [],
      sound: [],
      annotations: [],
    },
    playheadMs: 0,
    snapEnabled: true,
    durationMs: 10_000,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "presets",
    soundDrawerOpen: false,
    exportModalOpen: false,
    activeJobs: {},
    progressByJobId: {},
    // Fresh history + coalescer so tests don't leak state.
    history: new HistoryBuffer(HISTORY_CAP),
    coalescer: new Coalescer(COALESCE_IDLE_MS),
    canUndo: false,
    canRedo: false,
  });
}

beforeEach(() => {
  resetStore();
});

describe("undo slice", () => {
  it("undo_drag_reverts_clip_position: push move-clip, undo → original startMs", () => {
    const action: UndoableAction = {
      kind: "move-clip",
      trackId: "video",
      clipId: "v1",
      fromMs: 100,
      toMs: 900,
    };
    useEditorStore.getState().pushAction(action);
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);
    expect(useEditorStore.getState().canUndo).toBe(true);
    expect(useEditorStore.getState().canRedo).toBe(false);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(100);
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(useEditorStore.getState().canRedo).toBe(true);
  });

  it("redo_reapplies: undo then redo puts the clip at toMs", () => {
    useEditorStore.getState().pushAction({
      kind: "move-clip",
      trackId: "video",
      clipId: "v1",
      fromMs: 100,
      toMs: 900,
    });
    useEditorStore.getState().undo();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);
    expect(useEditorStore.getState().canRedo).toBe(false);
  });

  it("undo_new_action_clears_redo: push, undo, push → redo unavailable", () => {
    const st = useEditorStore.getState();
    st.pushAction({
      kind: "move-clip",
      trackId: "video",
      clipId: "v1",
      fromMs: 100,
      toMs: 900,
    });
    st.undo();
    expect(useEditorStore.getState().canRedo).toBe(true);
    useEditorStore.getState().pushAction({
      kind: "move-clip",
      trackId: "video",
      clipId: "v1",
      fromMs: 100,
      toMs: 400,
    });
    expect(useEditorStore.getState().canRedo).toBe(false);
    expect(useEditorStore.getState().canUndo).toBe(true);
  });

  it("undo_clear_on_project_reload: clearHistory zeroes both flags", () => {
    useEditorStore.getState().pushAction({
      kind: "move-clip",
      trackId: "video",
      clipId: "v1",
      fromMs: 100,
      toMs: 900,
    });
    expect(useEditorStore.getState().canUndo).toBe(true);
    useEditorStore.getState().clearHistory();
    expect(useEditorStore.getState().canUndo).toBe(false);
    expect(useEditorStore.getState().canRedo).toBe(false);
    expect(useEditorStore.getState().history.length).toBe(0);
  });

  it("consecutive_drags_same_clip_are_1_undo: 10 pushes within window collapse", () => {
    // Mock performance.now to control coalesce timing — all 10 pushes
    // land at t=0..450 ms within the 500 ms idle window.
    const nowSpy = vi.spyOn(performance, "now");
    for (let i = 0; i < 10; i++) {
      nowSpy.mockReturnValueOnce(i * 50);
      useEditorStore.getState().pushAction({
        kind: "move-clip",
        trackId: "video",
        clipId: "v1",
        fromMs: 100 + (i === 0 ? 0 : i * 50),
        toMs: 100 + (i + 1) * 50,
      });
    }
    // Final position = 100 + 10*50 = 600.
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(600);
    // History should be exactly one entry.
    expect(useEditorStore.getState().history.length).toBe(1);

    // Single undo reverts the WHOLE drag to original.
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(100);
    nowSpy.mockRestore();
  });

  it("set-effect-param coalesces with 500 ms idle and splits past it", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          { id: "c1", trackId: "cursor", startMs: 0, durationMs: 100, metadata: { label: "" } },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });
    const nowSpy = vi.spyOn(performance, "now");
    // 5 keystrokes at 0, 100, 200, 300, 400 ms — all coalesce.
    const letters = ["h", "he", "hel", "hell", "hello"];
    for (let i = 0; i < 5; i++) {
      nowSpy.mockReturnValueOnce(i * 100);
      useEditorStore.getState().pushAction({
        kind: "set-effect-param",
        nodePath: "tracks.cursor[0].metadata",
        field: "label",
        prev: i === 0 ? "" : letters[i - 1],
        next: letters[i]!,
      });
    }
    expect(useEditorStore.getState().history.length).toBe(1);
    // 700 ms later (past the 500 ms idle) → new entry.
    nowSpy.mockReturnValueOnce(700 + 400);
    useEditorStore.getState().pushAction({
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0].metadata",
      field: "label",
      prev: "hello",
      next: "hello!",
    });
    expect(useEditorStore.getState().history.length).toBe(2);
    nowSpy.mockRestore();
  });

  it("ring cap evicts oldest when 51st push lands", () => {
    for (let i = 0; i < 51; i++) {
      useEditorStore.getState().pushAction({
        kind: "delete-clip",
        trackId: "video",
        clipId: `ghost-${i}`, // non-existent clip ids so apply is a no-op
        snapshot: {
          id: `ghost-${i}`,
          trackId: "video",
          startMs: 0,
          durationMs: 0,
        },
      });
    }
    expect(useEditorStore.getState().history.length).toBe(HISTORY_CAP);
  });
});

describe("useUndoRedo hook", () => {
  it("returns the current canUndo/canRedo from the store", () => {
    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    act(() => {
      useEditorStore.getState().pushAction({
        kind: "move-clip",
        trackId: "video",
        clipId: "v1",
        fromMs: 100,
        toMs: 900,
      });
    });
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.redo();
    });
    expect(result.current.canRedo).toBe(false);
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);
  });

  it("keyboard shortcut mod+z triggers undo", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      useEditorStore.getState().pushAction({
        kind: "move-clip",
        trackId: "video",
        clipId: "v1",
        fromMs: 100,
        toMs: 900,
      });
    });
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);

    // Simulate Cmd+Z (meta). react-hotkeys-hook binds on `keydown` at
    // document level.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(100);
  });

  it("keyboard shortcut ctrl+y triggers redo (Windows convention)", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      useEditorStore.getState().pushAction({
        kind: "move-clip",
        trackId: "video",
        clipId: "v1",
        fromMs: 100,
        toMs: 900,
      });
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(100);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "y",
          code: "KeyY",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);
  });
});

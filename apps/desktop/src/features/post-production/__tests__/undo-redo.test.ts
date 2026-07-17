/**
 * Undo/redo slice + hotkey binding tests.
 *
 * Coverage:
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
      video: [{ id: "v1", trackId: "video", startMs: 100, durationMs: 500, sourcePath: "/v.mp4" }],
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
          { id: "c1", trackId: "cursor", startMs: 0, durationMs: 100, label: "", trajectoryDir: "/c", trajectoryFps: 60, trajectoryFrameCount: 0, skin: "mac-default", sizeScale: 1 },
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
        nodePath: "tracks.cursor[0]",
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

  it("undoes and redoes atomic cursor click-effect replacements", () => {
    const legacy = { style: "ring", color: "white", intensity: "normal" } as const;
    const press = { style: "press", color: "brand", intensity: "strong" } as const;
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [
          {
            id: "c1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 100,
            trajectoryDir: "/c.actions.json",
            trajectoryKind: "actions",
            trajectoryFps: 60,
            trajectoryFrameCount: 0,
            skin: "mac-default",
            sizeScale: 1,
            clickEffect: legacy,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    useEditorStore.getState().pushAction({
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "clickEffect",
      prev: legacy,
      next: press,
    });
    expect(useEditorStore.getState().tracks.cursor[0]?.clickEffect).toEqual(press);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.cursor[0]?.clickEffect).toEqual(legacy);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().tracks.cursor[0]?.clickEffect).toEqual(press);
  });

  describe("delete-clip undo/redo across non-sound tracks", () => {
    // Verifies the generic `add-clip` invert restores the deleted clip
    // at its original index for every non-sound track. Regression test
    // for the previous sound-track-only `restoreDeletedClip` path.
    const cases: Array<{ trackId: "video" | "cursor" | "zoom" | "annotations" }> = [
      { trackId: "video" },
      { trackId: "cursor" },
      { trackId: "zoom" },
      { trackId: "annotations" },
    ];

    function mkClip(
      trackId: "video" | "cursor" | "zoom" | "annotations",
      id: string,
      startMs: number,
      durationMs: number,
    ) {
      switch (trackId) {
        case "video":
          return { id, trackId, startMs, durationMs, sourcePath: "/v.mp4" } as const;
        case "cursor":
          return { id, trackId, startMs, durationMs, trajectoryDir: "/c", trajectoryFps: 60, trajectoryFrameCount: 0, skin: "mac-default" as const, sizeScale: 1 };
        case "zoom":
          return { id, trackId, startMs, durationMs, target: { kind: "cursor" as const }, scale: 1.5, center: { x: 0.5, y: 0.5 } };
        case "annotations":
          return { id, trackId, startMs, durationMs, text: "T", pos: { x: 0.5, y: 0.9 }, sizePt: 24 };
      }
    }

    for (const { trackId } of cases) {
      it(`delete + undo + redo round-trips on ${trackId} track at original index`, () => {
        const c0 = mkClip(trackId, `${trackId}-0`, 0, 100);
        const c1 = mkClip(trackId, `${trackId}-1`, 200, 100);
        const c2 = mkClip(trackId, `${trackId}-2`, 400, 100);
        useEditorStore.setState({
          tracks: {
            video: [],
            cursor: [],
            zoom: [],
            sound: [],
            annotations: [],
            [trackId]: [c0, c1, c2],
          } as ReturnType<typeof useEditorStore.getState>["tracks"],
        });

        // Delete the middle clip — index 1.
        useEditorStore.getState().pushAction({
          kind: "delete-clip",
          trackId,
          clipId: c1.id,
          snapshot: c1,
        });
        let track = useEditorStore.getState().tracks[trackId];
        expect(track).toHaveLength(2);
        expect(track.map((c) => c.id)).toEqual([c0.id, c2.id]);

        // Undo restores the clip at its original index.
        useEditorStore.getState().undo();
        track = useEditorStore.getState().tracks[trackId];
        expect(track).toHaveLength(3);
        expect(track.map((c) => c.id)).toEqual([c0.id, c1.id, c2.id]);
        expect(track[1]).toEqual(c1);

        // Redo deletes again.
        useEditorStore.getState().redo();
        track = useEditorStore.getState().tracks[trackId];
        expect(track).toHaveLength(2);
        expect(track.map((c) => c.id)).toEqual([c0.id, c2.id]);
      });
    }
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
          sourcePath: "",
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
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    try {
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
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: originalUserAgent,
      });
    }
  });
});

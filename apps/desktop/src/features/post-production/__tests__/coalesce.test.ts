/**
 * History buffer + coalescer + action apply/invert tests.
 *
 * Coverage:
 *   1. ring_buffer_cap_50 — 51st push evicts oldest, length stays at cap.
 *   2. push_truncates_redo_branch — new push after undo wipes redo.
 *   3. coalesce_drag_same_clip — sequential move-clip collapses to 1.
 *   4. coalesce_text_edit_idle — within-idle collapses, past-idle splits.
 *   5. coalesce_across_kinds_separate — different kinds never merge.
 *   6. coalesce_different_clip_ids_separate — same kind, different id, separate.
 *   7. apply_invert_move_clip — round-trips clip.startMs.
 *   8. apply_invert_delete_clip — restores full snapshot.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { HistoryBuffer, type HistoryEntry } from "../undo/history-buffer";
import { Coalescer, COALESCE_IDLE_MS, coalesceKey, mergeActions } from "../undo/coalesce";
import {
  applyAction,
  invertAction,
  restoreDeletedClip,
  parseNodePath,
  setAtPath,
  type UndoableAction,
} from "../undo/actions";
import { useEditorStore } from "../state/store";
import type { Clip } from "../state/timeline-slice";

function resetStore() {
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations: [] },
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
  });
}

function entry(action: UndoableAction, appliedAt = 0): HistoryEntry {
  return { action, appliedAt };
}

beforeEach(() => {
  resetStore();
});
describe("HistoryBuffer", () => {
  it("ring_buffer_cap_50: 51st push evicts oldest and cursor stays at end", () => {
    const buf = new HistoryBuffer(50);
    for (let i = 0; i < 51; i++) {
      buf.push(
        entry({
          kind: "move-clip",
          trackId: "video",
          clipId: `c${i}`,
          fromMs: 0,
          toMs: i,
        }),
      );
    }
    expect(buf.length).toBe(50);
    expect(buf.cursorPosition).toBe(49);
    // Oldest entry (c0) is gone; c1 is now the first.
    const first = buf.snapshot()[0]!.action;
    expect(first.kind).toBe("move-clip");
    expect((first as { clipId: string }).clipId).toBe("c1");
  });

  it("push_truncates_redo_branch: push A,B,C; undo twice; push D → buffer = [A, D]", () => {
    const buf = new HistoryBuffer(50);
    const mk = (id: string, to: number): HistoryEntry =>
      entry({ kind: "move-clip", trackId: "video", clipId: id, fromMs: 0, toMs: to });
    buf.push(mk("A", 100));
    buf.push(mk("B", 200));
    buf.push(mk("C", 300));
    expect(buf.length).toBe(3);
    buf.popUndo(); // cursor=1 (C undone)
    buf.popUndo(); // cursor=0 (B undone)
    expect(buf.canRedo()).toBe(true);
    buf.push(mk("D", 400));
    expect(buf.length).toBe(2);
    expect(buf.canRedo()).toBe(false);
    const snap = buf.snapshot();
    expect((snap[0]!.action as { clipId: string }).clipId).toBe("A");
    expect((snap[1]!.action as { clipId: string }).clipId).toBe("D");
  });

  it("popUndo/popRedo navigate the cursor correctly", () => {
    const buf = new HistoryBuffer(50);
    buf.push(
      entry({
        kind: "move-clip",
        trackId: "video",
        clipId: "a",
        fromMs: 0,
        toMs: 100,
      }),
    );
    expect(buf.canUndo()).toBe(true);
    expect(buf.canRedo()).toBe(false);
    const u = buf.popUndo();
    expect(u).not.toBeNull();
    expect(buf.canUndo()).toBe(false);
    expect(buf.canRedo()).toBe(true);
    const r = buf.popRedo();
    expect(r).not.toBeNull();
    expect(buf.canUndo()).toBe(true);
    expect(buf.canRedo()).toBe(false);
  });
});

describe("Coalescer", () => {
  it("coalesce_drag_same_clip: 10 move-clip within window collapse to 1, spanning full delta", () => {
    const c = new Coalescer(500);
    const mk = (to: number): UndoableAction => ({
      kind: "move-clip",
      trackId: "video",
      clipId: "X",
      fromMs: to - 10,
      toMs: to,
    });
    // First is "new", fromMs=0, toMs=10.
    const first = c.feed(
      { kind: "move-clip", trackId: "video", clipId: "X", fromMs: 0, toMs: 10 },
      0,
    );
    expect(first.kind).toBe("new");

    let last = first.entry;
    for (let i = 1; i < 10; i++) {
      const r = c.feed(mk((i + 1) * 10), i * 50);
      expect(r.kind).toBe("coalesced");
      last = r.entry;
    }
    // Merged entry: fromMs = 0 (first.fromMs), toMs = 100 (last.toMs)
    const merged = last.action as Extract<UndoableAction, { kind: "move-clip" }>;
    expect(merged.fromMs).toBe(0);
    expect(merged.toMs).toBe(100);
  });

  it("coalesce_text_edit_idle: 5 within 300 ms collapse to 1; 600 ms later starts a new entry", () => {
    const c = new Coalescer(500);
    const mk = (val: string, prev: string): UndoableAction => ({
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "label",
      prev,
      next: val,
    });
    let r = c.feed(mk("h", ""), 0);
    expect(r.kind).toBe("new");
    for (let i = 1; i <= 4; i++) {
      r = c.feed(mk("hello".slice(0, i + 1), "hello".slice(0, i)), i * 300);
      expect(r.kind).toBe("coalesced");
    }
    const merged = r.entry.action as Extract<UndoableAction, { kind: "set-effect-param" }>;
    expect(merged.prev).toBe("");
    expect(merged.next).toBe("hello");

    // 600 ms after the last (t=4*300=1200 + 600 = 1800) → new entry.
    const after = c.feed(mk("hello!", "hello"), 1800);
    expect(after.kind).toBe("new");
  });

  it("coalesce_across_kinds_separate: move-clip then set-effect-param → 2 entries", () => {
    const c = new Coalescer(500);
    const r1 = c.feed(
      { kind: "move-clip", trackId: "video", clipId: "X", fromMs: 0, toMs: 100 },
      0,
    );
    const r2 = c.feed(
      {
        kind: "set-effect-param",
        nodePath: "tracks.cursor[0]",
        field: "scale",
        prev: 1,
        next: 2,
      },
      10,
    );
    expect(r1.kind).toBe("new");
    expect(r2.kind).toBe("new");
  });

  it("coalesce_different_clip_ids_separate: two move-clip different ids → 2 entries", () => {
    const c = new Coalescer(500);
    const r1 = c.feed(
      { kind: "move-clip", trackId: "video", clipId: "A", fromMs: 0, toMs: 100 },
      0,
    );
    const r2 = c.feed(
      { kind: "move-clip", trackId: "video", clipId: "B", fromMs: 0, toMs: 100 },
      10,
    );
    expect(r1.kind).toBe("new");
    expect(r2.kind).toBe("new");
  });

  it("discrete actions never coalesce: delete-clip gets null key", () => {
    const clip: Clip = { id: "c", trackId: "video", startMs: 0, durationMs: 1000, sourcePath: "/v.mp4" };
    expect(
      coalesceKey({ kind: "delete-clip", trackId: "video", clipId: "c", snapshot: clip }),
    ).toBeNull();
    expect(
      coalesceKey({
        kind: "apply-preset",
        prevGraphSnapshot: {},
        nextPresetId: "p1",
      }),
    ).toBeNull();
    expect(
      coalesceKey({
        kind: "change-background",
        prev: { kind: "transparent", foregroundScale: 0.85 },
        next: { kind: "transparent", foregroundScale: 0.85 },
      }),
    ).toBeNull();
  });

  it("COALESCE_IDLE_MS constant is 500 (D-15)", () => {
    expect(COALESCE_IDLE_MS).toBe(500);
  });

  it("reset() breaks the coalesce window", () => {
    const c = new Coalescer(500);
    const mk = (to: number): UndoableAction => ({
      kind: "move-clip",
      trackId: "video",
      clipId: "X",
      fromMs: 0,
      toMs: to,
    });
    c.feed(mk(10), 0);
    c.reset();
    const r = c.feed(mk(20), 10);
    expect(r.kind).toBe("new");
  });
});

describe("mergeActions", () => {
  it("keeps prev.fromMs and takes next.toMs for move-clip", () => {
    const a: UndoableAction = {
      kind: "move-clip",
      trackId: "video",
      clipId: "X",
      fromMs: 0,
      toMs: 10,
    };
    const b: UndoableAction = {
      kind: "move-clip",
      trackId: "video",
      clipId: "X",
      fromMs: 10,
      toMs: 20,
    };
    const m = mergeActions(a, b) as Extract<UndoableAction, { kind: "move-clip" }>;
    expect(m.fromMs).toBe(0);
    expect(m.toMs).toBe(20);
  });
});

describe("parseNodePath + setAtPath", () => {
  it("parses bracket indexes and dot segments", () => {
    expect(parseNodePath("tracks.cursor[0].metadata")).toEqual([
      "tracks",
      "cursor",
      0,
      "metadata",
    ]);
  });

  it("setAtPath creates a new record with the field updated", () => {
    const root = { tracks: { cursor: [{ metadata: { scale: 1 } }] } };
    const out = setAtPath(root, ["tracks", "cursor", 0, "metadata"], "scale", 2) as {
      tracks: { cursor: { metadata: { scale: number } }[] };
    };
    expect(out.tracks.cursor[0]!.metadata.scale).toBe(2);
    // Original untouched.
    expect(root.tracks.cursor[0]!.metadata.scale).toBe(1);
  });
});

describe("applyAction + invertAction", () => {
  it("applies and inverts a sync-group edit atomically", () => {
    const video = { id: "v", trackId: "video" as const, startMs: 0, durationMs: 100, sourcePath: "/tmp/a.mp4", syncGroupId: "g" };
    const cursor = { id: "c", trackId: "cursor" as const, startMs: 0, durationMs: 100, trajectoryDir: "/tmp/a.json", trajectoryFps: 60, trajectoryFrameCount: 6, skin: "mac-default" as const, sizeScale: 1, syncGroupId: "g" };
    const before: Clip[] = [video, cursor];
    const after: Clip[] = before.map((clip) => ({ ...clip, startMs: 25, durationMs: 125 }));
    useEditorStore.setState({ tracks: { video: [video], cursor: [cursor], zoom: [], sound: [], annotations: [] } });
    const action: UndoableAction = { kind: "edit-sync-group", syncGroupId: "g", before, after };
    applyAction(action);
    expect(useEditorStore.getState().tracks.video[0]).toMatchObject({ startMs: 25, durationMs: 125 });
    expect(useEditorStore.getState().tracks.cursor[0]).toMatchObject({ startMs: 25, durationMs: 125 });
    applyAction(invertAction(action));
    expect(useEditorStore.getState().tracks.video[0]).toMatchObject({ startMs: 0, durationMs: 100 });
    expect(useEditorStore.getState().tracks.cursor[0]).toMatchObject({ startMs: 0, durationMs: 100 });
  });

  it("apply_invert_move_clip: applies to.Ms then undoes back to from.Ms", () => {
    useEditorStore.setState({
      tracks: {
        video: [{ id: "c1", trackId: "video", startMs: 100, durationMs: 500, sourcePath: "/v.mp4" }],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });
    const action: UndoableAction = {
      kind: "move-clip",
      trackId: "video",
      clipId: "c1",
      fromMs: 100,
      toMs: 900,
    };
    applyAction(action);
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(900);

    const inv = invertAction(action) as Extract<UndoableAction, { kind: "move-clip" }>;
    expect(inv.fromMs).toBe(900);
    expect(inv.toMs).toBe(100);
    applyAction(inv);
    expect(useEditorStore.getState().tracks.video[0]!.startMs).toBe(100);
  });

  it("apply_invert_delete_clip: delete then restoreDeletedClip puts the clip back", () => {
    const clip: Clip = {
      id: "c1",
      trackId: "cursor",
      startMs: 500,
      durationMs: 200,
      label: "Click",
      trajectoryDir: "/c",
      trajectoryFps: 60,
      trajectoryFrameCount: 0,
      skin: "mac-default",
      sizeScale: 1,
    };
    useEditorStore.setState({
      tracks: { video: [], cursor: [clip], zoom: [], sound: [], annotations: [] },
    });
    const del: UndoableAction = {
      kind: "delete-clip",
      trackId: "cursor",
      clipId: "c1",
      snapshot: clip,
    };
    applyAction(del);
    expect(useEditorStore.getState().tracks.cursor).toHaveLength(0);

    // Restore via the dedicated helper (handles non-sound tracks).
    restoreDeletedClip(del as Extract<UndoableAction, { kind: "delete-clip" }>);
    const restored = useEditorStore.getState().tracks.cursor[0]!;
    expect(restored.id).toBe("c1");
    expect(restored.startMs).toBe(500);
    expect(restored.label).toBe("Click");
  });

  it("apply_invert_add_sound_clip: add then invert (delete) removes it", () => {
    const clip = { id: "sfx", trackId: "sound" as const, startMs: 0, durationMs: 1000, path: "/s.mp3", kind: "sfx" as const };
    const add: UndoableAction = { kind: "add-sound-clip", trackId: "sound", clip };
    applyAction(add);
    expect(useEditorStore.getState().tracks.sound).toHaveLength(1);
    const inv = invertAction(add);
    expect(inv.kind).toBe("delete-clip");
    applyAction(inv);
    expect(useEditorStore.getState().tracks.sound).toHaveLength(0);
  });

  it("apply_invert_set_effect_param: write + undo restores prev value", () => {
    useEditorStore.setState({
      tracks: {
        video: [],
        cursor: [{ id: "c", trackId: "cursor", startMs: 0, durationMs: 100, trajectoryDir: "/c", trajectoryFps: 60, trajectoryFrameCount: 0, skin: "mac-default", sizeScale: 1 }],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });
    const action: UndoableAction = {
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "sizeScale",
      prev: 1,
      next: 2.5,
    };
    applyAction(action);
    expect(useEditorStore.getState().tracks.cursor[0]!.sizeScale).toBe(2.5);
    applyAction(invertAction(action));
    expect(useEditorStore.getState().tracks.cursor[0]!.sizeScale).toBe(1);
  });

  it("apply_invert_change_background: writes to _undoExtras", () => {
    const action: UndoableAction = {
      kind: "change-background",
      prev: { kind: "transparent", foregroundScale: 0.85 },
      next: { kind: "gradient", preset_id: "runway-dark", foregroundScale: 0.85 },
    };
    applyAction(action);
    const extras = (useEditorStore.getState() as unknown as {
      _undoExtras?: { background: Record<string, unknown> };
    })._undoExtras;
    expect(extras?.background).toEqual({
      kind: "gradient",
      preset_id: "runway-dark",
      foregroundScale: 0.85,
    });
    applyAction(invertAction(action));
    const after = (useEditorStore.getState() as unknown as {
      _undoExtras?: { background: Record<string, unknown> };
    })._undoExtras;
    expect(after?.background).toEqual({ kind: "transparent", foregroundScale: 0.85 });
  });

  it("apply_invert_edit_text_overlay: round-trips a text overlay", () => {
    const action: UndoableAction = {
      kind: "edit-text-overlay",
      overlayId: "t1",
      prev: { text: "Hello" },
      next: { text: "World" },
    };
    applyAction(action);
    const extras = (useEditorStore.getState() as unknown as {
      _undoExtras?: { textOverlays: Record<string, { text: string }> };
    })._undoExtras;
    expect(extras?.textOverlays.t1?.text).toBe("World");
    applyAction(invertAction(action));
    const after = (useEditorStore.getState() as unknown as {
      _undoExtras?: { textOverlays: Record<string, { text: string }> };
    })._undoExtras;
    expect(after?.textOverlays.t1?.text).toBe("Hello");
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/store";
import type { AnnotationClip } from "../state/timeline-slice";
import { Coalescer } from "./coalesce";
import { HISTORY_CAP, HistoryBuffer } from "./history-buffer";

function annotation(id: string, overrides: Partial<AnnotationClip> = {}): AnnotationClip {
  return {
    id,
    trackId: "annotations",
    startMs: 1000,
    durationMs: 2000,
    text: id,
    pos: { x: 0.5, y: 0.5 },
    sizePt: 24,
    ...overrides,
  };
}

function resetStore(annotations: AnnotationClip[]) {
  const initial = useEditorStore.getInitialState();
  useEditorStore.setState({
    tracks: { video: [], cursor: [], zoom: [], sound: [], annotations },
    history: new HistoryBuffer(HISTORY_CAP),
    coalescer: new Coalescer(),
    canUndo: false,
    canRedo: false,
    pushAction: initial.pushAction,
    undo: initial.undo,
    redo: initial.redo,
  });
}

afterEach(() => resetStore([]));

describe("edit-clip-snapshots", () => {
  it("restores every clip exactly through one undo and redo entry", () => {
    const source = annotation("source", {
      text: "Source",
      styleId: "title",
      sizePt: 34,
      pos: { x: 0.2, y: 0.8 },
    });
    const first = annotation("first", {
      text: "First copy",
      startMs: 4000,
      durationMs: 900,
      styleId: "callout",
      anchor: { kind: "cursor", offset: { x: 0.04, y: -0.06 } },
    });
    const second = annotation("second", {
      text: "Second copy",
      startMs: 6000,
      styleId: "lower-third",
      pos: { x: 0.1, y: 0.9 },
    });
    const afterFirst: AnnotationClip = {
      ...first,
      sizePt: 34,
      color: "#ffcc00",
      maxWidthPct: 72,
    };
    const afterSecond: AnnotationClip = {
      ...second,
      sizePt: 34,
      color: "#ffcc00",
      maxWidthPct: 72,
    };
    resetStore([source, first, second]);

    useEditorStore.getState().pushAction({
      kind: "edit-clip-snapshots",
      before: [first, second],
      after: [afterFirst, afterSecond],
    });

    expect(useEditorStore.getState().history.length).toBe(1);
    expect(useEditorStore.getState().tracks.annotations).toEqual([source, afterFirst, afterSecond]);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.annotations).toEqual([source, first, second]);
    expect(useEditorStore.getState().canRedo).toBe(true);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().tracks.annotations).toEqual([source, afterFirst, afterSecond]);
  });

  it("keeps consecutive snapshot transactions as separate undo steps", () => {
    const before = annotation("text-1");
    const first = { ...before, sizePt: 30 };
    const second = { ...first, color: "#ff0055" };
    resetStore([before]);

    useEditorStore.getState().pushAction({
      kind: "edit-clip-snapshots",
      before: [before],
      after: [first],
    });
    useEditorStore.getState().pushAction({
      kind: "edit-clip-snapshots",
      before: [first],
      after: [second],
    });

    expect(useEditorStore.getState().history.length).toBe(2);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.annotations[0]).toEqual(first);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().tracks.annotations[0]).toEqual(before);
  });
});

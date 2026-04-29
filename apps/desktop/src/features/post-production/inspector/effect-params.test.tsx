import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EffectParams } from "./effect-params";
import { useEditorStore } from "../state/store";
import { Coalescer, COALESCE_IDLE_MS } from "../undo/coalesce";
import { HistoryBuffer, HISTORY_CAP } from "../undo/history-buffer";
import type { UndoableAction } from "../undo/actions";

function resetStore(pushAction: (action: UndoableAction) => void = vi.fn()) {
  useEditorStore.setState({
    tracks: {
      video: [],
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
    selectedTab: "effects",
    soundDrawerOpen: false,
    exportModalOpen: false,
    activeJobs: {},
    progressByJobId: {},
    history: new HistoryBuffer(HISTORY_CAP),
    coalescer: new Coalescer(COALESCE_IDLE_MS),
    canUndo: false,
    canRedo: false,
    pushAction,
  });
}

function expectSetParam(
  pushAction: ReturnType<typeof vi.fn>,
  action: Extract<UndoableAction, { kind: "set-effect-param" }>,
) {
  expect(pushAction).toHaveBeenLastCalledWith(action);
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore(useEditorStore.getInitialState().pushAction);
});

describe("EffectParams", () => {
  it("dispatches typed zoom parameter edits with numeric track paths", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "zoom-1",
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 500,
            durationMs: 1000,
            label: "Zoom",
            target: { kind: "cursor" },
            scale: 1.5,
            center: { x: 0.5, y: 0.5 },
            preset: "DYNAMIC",
          },
        ],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    fireEvent.change(screen.getByLabelText("Zoom target"), {
      target: { value: "element" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "target",
      prev: { kind: "cursor" },
      next: { kind: "element", selector: "" },
    });

    fireEvent.change(screen.getByLabelText("Zoom scale"), {
      target: { value: "2" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "scale",
      prev: 1.5,
      next: 2,
    });

    fireEvent.change(screen.getByLabelText("Zoom center x"), {
      target: { value: "0.25" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0].center",
      field: "x",
      prev: 0.5,
      next: 0.25,
    });

    fireEvent.change(screen.getByLabelText("Zoom preset"), {
      target: { value: "CALM" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "preset",
      prev: "DYNAMIC",
      next: "CALM",
    });
  });

  it("dispatches typed annotation edits with numeric track paths", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "text-1",
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-1",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 1000,
            label: "Title",
            text: "Title",
            pos: { x: 0.5, y: 0.9 },
            sizePt: 24,
            color: "#ffffff",
          },
        ],
      },
    });

    render(<EffectParams />);

    fireEvent.change(screen.getByLabelText("Annotation text"), {
      target: { value: "New title" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "text",
      prev: "Title",
      next: "New title",
    });

    fireEvent.change(screen.getByLabelText("Annotation position y"), {
      target: { value: "0.75" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0].pos",
      field: "y",
      prev: 0.9,
      next: 0.75,
    });

    fireEvent.change(screen.getByLabelText("Annotation size"), {
      target: { value: "36" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "sizePt",
      prev: 24,
      next: 36,
    });

    fireEvent.change(screen.getByLabelText("Annotation color"), {
      target: { value: "#ff0055" },
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "color",
      prev: "#ffffff",
      next: "#ff0055",
    });
  });
});

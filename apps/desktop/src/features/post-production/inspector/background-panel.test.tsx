import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { BackgroundPanel } from "./background-panel";
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
    selectedTab: "background",
    soundDrawerOpen: false,
    exportModalOpen: false,
    activeJobs: {},
    progressByJobId: {},
    _undoExtras: {
      graphSnapshot: {},
      textOverlays: {},
      background: { kind: "transparent" },
    },
    history: new HistoryBuffer(HISTORY_CAP),
    coalescer: new Coalescer(COALESCE_IDLE_MS),
    canUndo: false,
    canRedo: false,
    pushAction,
  });
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore(useEditorStore.getInitialState().pushAction);
});

describe("BackgroundPanel", () => {
  it("dispatches change-background for solid color edits", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    render(<BackgroundPanel />);

    fireEvent.change(screen.getByLabelText("Solid background color"), {
      target: { value: "#ff0055" },
    });

    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "transparent" },
      next: { kind: "solid", color: { r: 255, g: 0, b: 85, a: 255 } },
    });
  });

  it("dispatches change-background for gradient preset and transparent toggle", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark" },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.change(screen.getByLabelText("Gradient background preset"), {
      target: { value: "warm-sunset" },
    });
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark" },
      next: { kind: "gradient", preset_id: "warm-sunset" },
    });

    fireEvent.click(screen.getByLabelText("Transparent background"));
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark" },
      next: { kind: "transparent" },
    });
  });
});

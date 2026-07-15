import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../state/store";
import type { UndoableAction } from "../undo/actions";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";
import { BackgroundPanel } from "./background-panel";

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
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "solid", color: { r: 16, g: 18, b: 24, a: 255 } },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.change(screen.getByLabelText("Solid background color"), {
      target: { value: "#ff0055" },
    });

    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "solid", color: { r: 16, g: 18, b: 24, a: 255 } },
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

    fireEvent.click(screen.getByRole("button", { name: "Gradient preset Warm Sunset" }));
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark" },
      next: { kind: "gradient", preset_id: "warm-sunset" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Transparent/ }));
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark" },
      next: { kind: "transparent" },
    });
  });

  it("dispatches change-background for image presets", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "image", assetId: null, path: "" },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "macOS" }));
    fireEvent.click(screen.getByRole("button", { name: "Image background Big Sur Dark" }));

    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "image", assetId: null, path: "" },
      next: {
        kind: "image",
        assetId: "macos:bigsur-dark",
        path: expect.stringContaining("bigsur-dark.jpg"),
      },
    });
  });

  it("selects the image tab from a stable bundled asset id", () => {
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: {
          kind: "image",
          assetId: "macos:sequoia-dark",
          path: "/assets/stale-sequoia-hash.jpeg",
        },
      },
    });

    render(<BackgroundPanel />);

    expect(screen.getByRole("tab", { name: "macOS" })).toHaveAttribute("aria-selected", "true");
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../state/store";
import type { UndoableAction } from "../undo/actions";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";
import { BackgroundPanel } from "./background-panel";

vi.mock("@storycapture/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@storycapture/ui")>()),
  ScSlider: ({
    id,
    min,
    max,
    step,
    value,
    format,
    disabled,
    onValueChange,
    onValueCommitted,
    onKeyDownCapture,
    onKeyUpCapture,
    onBlurCapture,
    onPointerCancelCapture,
    onLostPointerCapture,
  }: {
    id?: string;
    min?: number;
    max?: number;
    step?: number;
    value?: number | readonly number[];
    format?: Intl.NumberFormatOptions;
    disabled?: boolean;
    onValueChange?: (value: number) => void;
    onValueCommitted?: (value: number) => void;
    onKeyDownCapture?: React.KeyboardEventHandler<HTMLInputElement>;
    onKeyUpCapture?: React.KeyboardEventHandler<HTMLInputElement>;
    onBlurCapture?: React.FocusEventHandler<HTMLInputElement>;
    onPointerCancelCapture?: React.PointerEventHandler<HTMLInputElement>;
    onLostPointerCapture?: React.PointerEventHandler<HTMLInputElement>;
  }) => {
    const currentValue = typeof value === "number" ? value : (value?.[0] ?? min ?? 0);
    return (
      <input
        id={`${id}-input`}
        aria-labelledby={`${id}-label`}
        aria-valuetext={new Intl.NumberFormat("en", format).format(currentValue)}
        type="range"
        min={min}
        max={max}
        step={step}
        value={currentValue}
        disabled={disabled}
        onKeyDownCapture={onKeyDownCapture}
        onKeyUpCapture={onKeyUpCapture}
        onBlurCapture={onBlurCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onLostPointerCapture={onLostPointerCapture}
        onChange={(event) => onValueChange?.(Number(event.currentTarget.value))}
        onPointerUp={(event) => onValueCommitted?.(Number(event.currentTarget.value))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const nextValue = Math.min(
            max ?? 100,
            Math.max(min ?? 0, Number(event.currentTarget.value) + direction * (step ?? 1)),
          );
          onValueChange?.(nextValue);
          onValueCommitted?.(nextValue);
        }}
      />
    );
  },
}));

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
    exportForm: {
      ...useEditorStore.getInitialState().exportForm,
      frameMode: "framed",
    },
    _undoExtras: {
      graphSnapshot: {},
      textOverlays: {},
      background: { kind: "transparent", foregroundScale: 0.85 },
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
        background: {
          kind: "solid",
          color: { r: 16, g: 18, b: 24, a: 255 },
          foregroundScale: 0.85,
        },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.change(screen.getByLabelText("Solid background color"), {
      target: { value: "#ff0055" },
    });

    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: {
        kind: "solid",
        color: { r: 16, g: 18, b: 24, a: 255 },
        foregroundScale: 0.85,
      },
      next: {
        kind: "solid",
        color: { r: 255, g: 0, b: 85, a: 255 },
        foregroundScale: 0.85,
      },
    });
  });

  it("dispatches change-background for gradient preset and transparent toggle", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "gradient", preset_id: "runway-dark", foregroundScale: 0.75 },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Gradient preset Warm Sunset" }));
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark", foregroundScale: 0.75 },
      next: { kind: "gradient", preset_id: "warm-sunset", foregroundScale: 0.75 },
    });

    fireEvent.click(screen.getByRole("button", { name: /Transparent/ }));
    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "gradient", preset_id: "runway-dark", foregroundScale: 0.75 },
      next: { kind: "transparent", foregroundScale: 0.75 },
    });
  });

  it("dispatches change-background for image presets", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "image", assetId: null, path: "", foregroundScale: 0.95 },
      },
    });
    render(<BackgroundPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "macOS" }));
    fireEvent.click(screen.getByRole("button", { name: "Image background Big Sur Dark" }));

    expect(pushAction).toHaveBeenLastCalledWith({
      kind: "change-background",
      prev: { kind: "image", assetId: null, path: "", foregroundScale: 0.95 },
      next: {
        kind: "image",
        assetId: "macos:bigsur-dark",
        path: expect.stringContaining("bigsur-dark.jpg"),
        foregroundScale: 0.95,
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
          foregroundScale: 0.85,
        },
      },
    });

    render(<BackgroundPanel />);

    expect(screen.getByRole("tab", { name: "macOS" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows presets, custom state, percentage, and accessible slider bounds", () => {
    useEditorStore.setState({
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.82 },
      },
    });

    render(<BackgroundPanel />);

    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Small 75%" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Balanced 85%" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Large 95%" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const slider = screen.getByRole("slider", { name: "Video size percentage" });
    expect(slider).toHaveAttribute("min", "70");
    expect(slider).toHaveAttribute("max", "100");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "82%");
    expect(slider).toHaveValue("82");
  });

  it("creates one undo entry for a preset click", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    render(<BackgroundPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Large 95%" }));

    expect(pushAction).toHaveBeenCalledTimes(1);
    expect(pushAction).toHaveBeenCalledWith({
      kind: "change-background",
      prev: { kind: "transparent", foregroundScale: 0.85 },
      next: { kind: "transparent", foregroundScale: 0.95 },
    });
  });

  it("updates live but creates one undo entry for a pointer gesture", () => {
    resetStore(useEditorStore.getInitialState().pushAction);
    render(<BackgroundPanel />);
    const slider = screen.getByRole("slider", { name: "Video size percentage" });

    fireEvent.change(slider, { target: { value: "80" } });
    fireEvent.change(slider, { target: { value: "78" } });

    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.78);
    expect(useEditorStore.getState().history.length).toBe(0);

    fireEvent.pointerUp(slider);

    expect(useEditorStore.getState().history.length).toBe(1);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.85);
    act(() => useEditorStore.getState().redo());
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.78);
  });

  it("creates one undo entry for a keyboard gesture", () => {
    resetStore(useEditorStore.getInitialState().pushAction);
    render(<BackgroundPanel />);
    const slider = screen.getByRole("slider", { name: "Video size percentage" });

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true });

    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.88);
    expect(useEditorStore.getState().history.length).toBe(0);

    fireEvent.keyUp(slider, { key: "ArrowRight" });

    expect(useEditorStore.getState().history.length).toBe(1);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.85);
  });

  it("finalizes a canceled pointer gesture without leaking its undo snapshot", () => {
    resetStore(useEditorStore.getInitialState().pushAction);
    render(<BackgroundPanel />);
    const slider = screen.getByRole("slider", { name: "Video size percentage" });

    fireEvent.change(slider, { target: { value: "80" } });
    fireEvent.pointerCancel(slider);

    expect(useEditorStore.getState().history.length).toBe(1);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.85);
  });

  it("shows source fill clearly and switches to framed mode for a size preset", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState((state) => ({
      exportForm: { ...state.exportForm, frameMode: "source" },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.75 },
      },
    }));

    render(<BackgroundPanel />);

    expect(screen.getByText("Source fill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Small 75%" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("slider", { name: "Video size percentage" })).toBeEnabled();
    expect(screen.getByText(/Source fill is full-bleed/)).toHaveTextContent(
      "currently overrides your saved 75% size",
    );

    fireEvent.click(screen.getByRole("button", { name: "Large 95%" }));
    expect(useEditorStore.getState().exportForm.frameMode).toBe("framed");
    expect(pushAction).toHaveBeenCalledWith({
      kind: "change-background",
      prev: { kind: "transparent", foregroundScale: 0.75 },
      next: { kind: "transparent", foregroundScale: 0.95 },
    });
  });

  it("switches to framed mode when the source-fill slider changes", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState((state) => ({
      exportForm: { ...state.exportForm, frameMode: "source" },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.75 },
      },
    }));

    render(<BackgroundPanel />);
    const slider = screen.getByRole("slider", { name: "Video size percentage" });

    fireEvent.change(slider, { target: { value: "80" } });
    expect(useEditorStore.getState().exportForm.frameMode).toBe("framed");
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.8);

    fireEvent.pointerUp(slider);
    expect(pushAction).toHaveBeenCalledWith({
      kind: "change-background",
      prev: { kind: "transparent", foregroundScale: 0.75 },
      next: { kind: "transparent", foregroundScale: 0.8 },
    });
  });

  it("switches source fill directly without changing the saved size", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState((state) => ({
      exportForm: { ...state.exportForm, frameMode: "source" },
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.75 },
      },
    }));

    render(<BackgroundPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Use cinematic frame" }));

    expect(useEditorStore.getState().exportForm.frameMode).toBe("framed");
    expect(useEditorStore.getState()._undoExtras?.background.foregroundScale).toBe(0.75);
    expect(pushAction).not.toHaveBeenCalled();
  });
});

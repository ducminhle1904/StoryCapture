import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingActions } from "@/ipc/actions";
import type { RecordingStepTimingSidecar } from "@/ipc/trajectory";
import { useEditorStore } from "../state/store";
import type { UndoableAction } from "../undo/actions";
import { COALESCE_IDLE_MS, Coalescer } from "../undo/coalesce";
import { HISTORY_CAP, HistoryBuffer } from "../undo/history-buffer";
import { EffectParams } from "./effect-params";

const ACTIONS: RecordingActions = {
  source_version: 1,
  confidence: "legacy-approximate",
  recording_path: "/tmp/demo.mp4",
  cursor_motion_preset: "natural",
  viewport: { width: 1000, height: 500 },
  capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
  fps_num: 60,
  fps_den: 1,
  frame_count: 600,
  events: [
    {
      source_index: 0,
      confidence: "legacy-approximate",
      step_id: "step-1",
      ordinal: 1,
      verb: "click",
      t_start_ms: 1000,
      t_action_ms: 2000,
      t_end_ms: 2200,
      target: {
        kind: "element",
        label: "Sign In",
        center: { x: 800, y: 300 },
        bounds: { x: 760, y: 280, w: 80, h: 40 },
      },
      secondary_target: null,
      pointer: { button: "left", effect: "click" },
      cursor_timing: null,
      input_timing: { kind: "click", action_ms: 2000 },
    },
  ],
};

const STEP_TIMING: RecordingStepTimingSidecar = {
  version: 1,
  recordingPath: "/tmp/demo.mp4",
  storyHash: "hash",
  timebase: "recording-ms",
  status: "completed",
  steps: [
    {
      ordinal: 1,
      stepId: "step-1",
      sceneName: "Checkout",
      verb: "click",
      startMs: 1000,
      endMs: 2600,
      durationMs: 1600,
      status: "succeeded",
      target: { bbox: { x: 760, y: 280, w: 80, h: 40 }, matchKind: "primary" },
      confidence: "high",
    },
  ],
};

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
    _undoExtras: undefined,
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

async function selectFieldOption(label: string, optionName: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected at least one matching element");
  return value;
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  resetStore(useEditorStore.getInitialState().pushAction);
});

describe("EffectParams", () => {
  it("dispatches typed zoom parameter edits with numeric track paths", async () => {
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

    expect(screen.getByRole("form", { name: "Effect parameters" })).toHaveClass(
      "min-w-0",
      "w-full",
      "max-w-full",
    );

    await selectFieldOption("Zoom target", "Element");
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "target",
      prev: { kind: "cursor" },
      next: { kind: "element", selector: "" },
    });

    const zoomScale = screen.getByRole("slider", { name: "Zoom scale" });
    fireEvent.keyDown(zoomScale, { key: "ArrowRight" });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "scale",
      prev: 1.5,
      next: 1.55,
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

    await selectFieldOption("Zoom preset", "CALM");
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.zoom[0]",
      field: "preset",
      prev: "DYNAMIC",
      next: "CALM",
    });
  });

  it("switches FX layer tabs and selects the first clip in that layer", async () => {
    const user = userEvent.setup();
    resetStore(vi.fn());
    useEditorStore.setState({
      selectedClipId: "text-1",
      tracks: {
        video: [],
        cursor: [],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 2500,
            durationMs: 800,
            label: "Script zoom",
            target: { kind: "cursor" },
            scale: 1.65,
            center: { x: 0.5, y: 0.5 },
            preset: "DYNAMIC",
          },
        ],
        sound: [],
        annotations: [
          {
            id: "text-1",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 1200,
            label: "Callout",
            text: "One line callout",
            pos: { x: 0.5, y: 0.16 },
            sizePt: 14,
            color: "#f8fafc",
            styleId: "callout",
          },
        ],
      },
    });

    render(<EffectParams />);

    expect(screen.getByRole("button", { name: /Text\s+1/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByLabelText("Annotation text")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Zoom\s+1/i }));

    expect(useEditorStore.getState().selectedClipId).toBe("zoom-1");
    expect(useEditorStore.getState().playheadMs).toBe(2500);
    expect(screen.getByRole("button", { name: /Zoom\s+1/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByLabelText("Zoom scale")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Text\s+1/i }));

    expect(useEditorStore.getState().selectedClipId).toBe("text-1");
    expect(screen.getByLabelText("Annotation text")).toBeInTheDocument();
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

    fireEvent.keyDown(screen.getByRole("slider", { name: "Annotation size" }), {
      key: "ArrowRight",
    });
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "sizePt",
      prev: 24,
      next: 25,
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

  it("resets appearance or changes preset in one snapshot while preserving clip layout", async () => {
    const user = userEvent.setup();
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
            startMs: 1200,
            durationMs: 2300,
            text: "Keep me",
            pos: { x: 0.22, y: 0.77 },
            sizePt: 40,
            styleId: "callout",
            color: "#ff00ff",
            maxWidthPct: 45,
            lineHeight: 1.8,
            animation: { in: "scale-in", out: "fade", durationMs: 400 },
            anchor: { kind: "safe-area", placement: "bottom" },
          },
        ],
      },
    });

    render(<EffectParams />);

    await user.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(pushAction).toHaveBeenCalledTimes(1);
    const resetAction = pushAction.mock.calls[0]?.[0];
    expect(resetAction).toMatchObject({ kind: "edit-clip-snapshots" });
    expect(resetAction.after[0]).toMatchObject({
      id: "text-1",
      text: "Keep me",
      startMs: 1200,
      durationMs: 2300,
      pos: { x: 0.22, y: 0.77 },
      anchor: { kind: "safe-area", placement: "bottom" },
      styleId: "callout",
      sizePt: 14,
    });
    expect(resetAction.after[0]).toHaveProperty("font", undefined);
    expect(resetAction.after[0]).toHaveProperty("boxStyle", undefined);
    expect(resetAction.after[0]).toHaveProperty("animation", undefined);

    pushAction.mockClear();
    await selectFieldOption("Text style preset", "Title");
    expect(pushAction).toHaveBeenCalledTimes(1);
    expect(pushAction.mock.calls[0]?.[0]).toMatchObject({
      kind: "edit-clip-snapshots",
      after: [
        expect.objectContaining({
          text: "Keep me",
          startMs: 1200,
          durationMs: 2300,
          pos: { x: 0.22, y: 0.77 },
          anchor: { kind: "safe-area", placement: "bottom" },
          styleId: "title",
          sizePt: 34,
        }),
      ],
    });
  });

  it("dispatches text anchor helper actions from the selected playhead step", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      playheadMs: 1500,
      selectedClipId: "text-1",
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.85 },
        actions: ACTIONS,
        stepTiming: STEP_TIMING,
      },
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-1",
            trackId: "annotations",
            startMs: 0,
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

    fireEvent.click(screen.getByRole("button", { name: "Fit step" }));
    expect(pushAction).toHaveBeenCalledWith({
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "startMs",
      prev: 0,
      next: 1000,
    });
    expect(pushAction).toHaveBeenCalledWith({
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "durationMs",
      prev: 1000,
      next: 1600,
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach target" }));
    expect(pushAction).toHaveBeenCalledWith({
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "anchor",
      prev: undefined,
      next: { kind: "target", stepId: "step-1", placement: "top" },
    });
    expect(pushAction).toHaveBeenCalledWith({
      kind: "set-effect-param",
      nodePath: "tracks.annotations[0]",
      field: "pos",
      prev: { x: 0.5, y: 0.9 },
      next: { x: 0.8, y: 0.5 },
    });
  });

  it("shows target fallback warning and dispatches text list actions", async () => {
    const user = userEvent.setup();
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "text-1",
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent", foregroundScale: 0.85 },
        actions: ACTIONS,
        stepTiming: STEP_TIMING,
      },
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
            label: "Missing",
            text: "Missing target",
            pos: { x: 0.25, y: 0.75 },
            sizePt: 24,
            color: "#ffffff",
            styleId: "callout",
            anchor: { kind: "target", stepId: "missing", placement: "top" },
          },
          {
            id: "text-2",
            trackId: "annotations",
            startMs: 3000,
            durationMs: 1000,
            label: "Second",
            text: "Second text",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 18,
          },
          {
            id: "text-3",
            trackId: "annotations",
            startMs: 5000,
            durationMs: 1000,
            label: "Title role",
            text: "Different role",
            pos: { x: 0.5, y: 0.2 },
            sizePt: 30,
            styleId: "title",
          },
          {
            id: "text-empty",
            trackId: "annotations",
            startMs: 6000,
            durationMs: 1000,
            label: "Empty",
            text: "   ",
            pos: { x: 0.5, y: 0.5 },
            sizePt: 18,
            styleId: "callout",
          },
        ],
      },
    });

    render(<EffectParams />);

    expect(screen.getByText(/falls back to the saved screen position/i)).toBeInTheDocument();

    await user.click(screen.getByText("Second text"));
    expect(useEditorStore.getState().selectedClipId).toBe("text-2");
    expect(useEditorStore.getState().playheadMs).toBe(3000);

    await user.click(screen.getAllByRole("button", { name: "Duplicate" })[0]!);
    expect(pushAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "add-clip", trackId: "annotations" }),
    );

    await user.click(screen.getAllByRole("button", { name: "Dupe style" })[0]!);
    expect(pushAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "add-clip", trackId: "annotations" }),
    );

    await user.click(first(screen.getAllByText("Apply style")));
    await user.click(first(screen.getAllByRole("menuitem", { name: "Same preset / role" })));
    expect(pushAction).toHaveBeenCalledWith({
      kind: "edit-clip-snapshots",
      before: [expect.objectContaining({ id: "text-2" })],
      after: [expect.objectContaining({ id: "text-2" })],
    });

    await user.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    expect(pushAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delete-clip",
        trackId: "annotations",
        clipId: "text-1",
      }),
    );
  });

  it("applies selected text style to all clips without changing text, timing, or anchors", async () => {
    const user = userEvent.setup();
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "text-source",
      tracks: {
        video: [],
        cursor: [],
        zoom: [],
        sound: [],
        annotations: [
          {
            id: "text-source",
            trackId: "annotations",
            startMs: 1000,
            durationMs: 2200,
            label: "Source",
            text: "Source title",
            pos: { x: 0.18, y: 0.82 },
            sizePt: 22,
            color: "#ffcc00",
            styleId: "lower-third",
            align: "left",
            boxStyle: {
              paddingPx: 14,
              radiusPx: 14,
              bgColor: "#111317d9",
              borderColor: "#ffffff1f",
            },
            animation: { in: "slide-up", out: "fade", durationMs: 220 },
            anchor: { kind: "safe-area", placement: "bottom" },
          },
          {
            id: "text-target",
            trackId: "annotations",
            startMs: 4000,
            durationMs: 1200,
            label: "Target",
            text: "Keep this copy",
            pos: { x: 0.5, y: 0.18 },
            sizePt: 18,
            color: "#ffffff",
            styleId: "callout",
            align: "center",
            anchor: { kind: "cursor", offset: { x: 0.04, y: -0.06 } },
            animation: { in: "fade", out: "none", durationMs: 140 },
          },
        ],
      },
    });

    render(<EffectParams />);

    await user.click(first(screen.getAllByText("Apply style")));
    await user.click(first(screen.getAllByRole("menuitem", { name: "All text" })));

    expect(pushAction).toHaveBeenCalledTimes(1);
    const action = pushAction.mock.calls[0]?.[0];
    expect(action).toMatchObject({
      kind: "edit-clip-snapshots",
      before: [expect.objectContaining({ id: "text-target" })],
      after: [
        expect.objectContaining({
          id: "text-target",
          styleId: "callout",
          text: "Keep this copy",
          startMs: 4000,
          durationMs: 1200,
          pos: { x: 0.5, y: 0.18 },
          anchor: { kind: "cursor", offset: { x: 0.04, y: -0.06 } },
          animation: { in: "fade", out: "none", durationMs: 140 },
          sizePt: 22,
          color: "#ffcc00",
          align: "left",
        }),
      ],
    });
  });

  it("dispatches cursor motion preset edits", async () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "cursor-1",
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 1000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryFps: 60,
            trajectoryFrameCount: 60,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    expect(screen.getByLabelText("Cursor motion")).toHaveTextContent("Natural");
    await selectFieldOption("Cursor motion", "Cinematic");
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "motionPreset",
      prev: "natural",
      next: "cinematic",
    });
  });

  it("edits normalized click effects as one undoable object", async () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "cursor-1",
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 1000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryKind: "actions",
            trajectoryFps: 60,
            trajectoryFrameCount: 60,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    expect(screen.getByLabelText("Cursor click effect")).toHaveTextContent("Ring");
    await selectFieldOption("Cursor click effect", "Press");
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "clickEffect",
      prev: undefined,
      next: { style: "press", color: "white", intensity: "normal" },
    });
  });

  it("disables click effect details for None without clearing saved choices", () => {
    resetStore();
    useEditorStore.setState({
      selectedClipId: "cursor-1",
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 1000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryKind: "actions",
            trajectoryFps: 60,
            trajectoryFrameCount: 60,
            skin: "mac-default",
            sizeScale: 1,
            clickEffect: { style: "none", color: "brand", intensity: "strong" },
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    expect(screen.getByLabelText("Cursor click effect color")).toBeDisabled();
    expect(screen.getByLabelText("Cursor click effect color")).toHaveTextContent("Brand");
    expect(screen.getByLabelText("Cursor click effect intensity")).toBeDisabled();
    expect(screen.getByLabelText("Cursor click effect intensity")).toHaveTextContent("Strong");
  });

  it("disables click effects and explains trajectory-only clips", () => {
    resetStore();
    useEditorStore.setState({
      selectedClipId: "cursor-1",
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 1000,
            trajectoryDir: "/tmp/demo.trajectory.json",
            trajectoryKind: "trajectory",
            trajectoryFps: 60,
            trajectoryFrameCount: 60,
            skin: "mac-default",
            sizeScale: 1,
          },
        ],
        zoom: [],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    expect(screen.getByText("Click effects require action timing.")).toBeInTheDocument();
    expect(screen.getByLabelText("Cursor click effect")).toBeDisabled();
    expect(screen.getByLabelText("Cursor skin")).not.toBeDisabled();
  });

  it("exposes active cursor motion while editing an overlapping zoom clip", async () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      selectedClipId: "zoom-1",
      tracks: {
        video: [],
        cursor: [
          {
            id: "cursor-1",
            trackId: "cursor",
            startMs: 0,
            durationMs: 5000,
            trajectoryDir: "/tmp/demo.actions.json",
            trajectoryFps: 60,
            trajectoryFrameCount: 300,
            skin: "mac-default",
            motionPreset: "snappy",
            sizeScale: 1,
          },
        ],
        zoom: [
          {
            id: "zoom-1",
            trackId: "zoom",
            startMs: 3000,
            durationMs: 900,
            label: "Script zoom",
            target: { kind: "cursor" },
            scale: 1.65,
            center: { x: 0.5, y: 0.5 },
            preset: "DYNAMIC",
          },
        ],
        sound: [],
        annotations: [],
      },
    });

    render(<EffectParams />);

    expect(screen.getByLabelText("Zoom scale")).toBeInTheDocument();
    expect(screen.getByLabelText("Cursor motion")).toHaveTextContent("Snappy");
    await selectFieldOption("Cursor motion", "Cinematic");
    expectSetParam(pushAction, {
      kind: "set-effect-param",
      nodePath: "tracks.cursor[0]",
      field: "motionPreset",
      prev: "snappy",
      next: "cinematic",
    });
  });
});

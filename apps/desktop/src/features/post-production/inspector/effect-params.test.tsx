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
  version: 1,
  recording_path: "/tmp/demo.mp4",
  viewport: { width: 1000, height: 500 },
  capture_rect: { x: 0, y: 0, width: 1000, height: 500 },
  fps: 60,
  frame_count: 600,
  events: [
    {
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

    await selectFieldOption("Zoom target", "Element");
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

    await selectFieldOption("Zoom preset", "CALM");
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

  it("dispatches text anchor helper actions from the selected playhead step", () => {
    const pushAction = vi.fn();
    resetStore(pushAction);
    useEditorStore.setState({
      playheadMs: 1500,
      selectedClipId: "text-1",
      _undoExtras: {
        graphSnapshot: {},
        textOverlays: {},
        background: { kind: "transparent" },
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
        background: { kind: "transparent" },
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

    await user.click(screen.getAllByRole("button", { name: "Style all" })[0]!);
    expect(pushAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-effect-param",
        nodePath: "tracks.annotations[1]",
        field: "styleId",
        next: "callout",
      }),
    );

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
          },
        ],
      },
    });

    render(<EffectParams />);

    await user.click(screen.getAllByRole("button", { name: "Style all" })[0]!);

    const fields = pushAction.mock.calls.map(([action]) => action.field);
    expect(fields).toEqual(["styleId", "sizePt", "color", "align", "boxStyle", "animation"]);
    expect(fields).not.toContain("text");
    expect(fields).not.toContain("startMs");
    expect(fields).not.toContain("durationMs");
    expect(fields).not.toContain("anchor");
    expect(pushAction.mock.calls[0]?.[0]).toMatchObject({
      kind: "set-effect-param",
      nodePath: "tracks.annotations[1]",
      field: "styleId",
      prev: "callout",
      next: "lower-third",
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

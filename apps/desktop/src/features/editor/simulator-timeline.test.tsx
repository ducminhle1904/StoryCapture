import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { useSimulatorStore } from "@/state/simulator-store";
import type { SimulatorStepFrame } from "@/ipc/simulator";
import { SimulatorTimeline } from "./simulator-timeline";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("sim-session-1"),
  Channel: class {
    onmessage: ((e: unknown) => void) | null = null;
    id = 1;
    __TAURI_CHANNEL_MARKER__ = true;
    toJSON() {
      return `__CHANNEL__:${this.id}`;
    }
  },
  convertFileSrc: (p: string) => p,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function mkFrame(
  ordinal: number,
  match_kind: SimulatorStepFrame["match_kind"] = "primary",
): SimulatorStepFrame {
  return {
    ordinal,
    screenshot_path: `/tmp/frame-${ordinal}.png`,
    cursor_xy: [10, 20],
    matched_selector: match_kind === "none" ? null : `button#step-${ordinal}`,
    matched_bbox: match_kind === "none" ? null : { x: 0, y: 0, w: 10, h: 10 },
    match_kind,
    duration_ms: 100,
  };
}

describe("SimulatorTimeline", () => {
  beforeEach(() => {
    useSimulatorStore.getState().resetToIdle();
  });

  it("renders empty state + Run simulator button when idle", () => {
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource={"scene x:\n  click \"ok\"\n"}
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    expect(screen.getByRole("button", { name: /run simulator/i })).toBeInTheDocument();
    expect(screen.getByText(/no simulator run yet/i)).toBeInTheDocument();
  });

  it("switches to Cancel button when running", () => {
    useSimulatorStore.getState().handleEvent({
      type: "started",
      session_id: "s",
      run_id: "r",
      total_steps: 3,
    });
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    expect(screen.getByRole("button", { name: /cancel simulator run/i })).toBeInTheDocument();
  });

  it("renders N frame cards when N frames captured", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 3 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1) });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 2, frame: mkFrame(2) });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 3, frame: mkFrame(3) });
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    const cards = screen.getAllByRole("button", { name: /simulator frame/i });
    expect(cards).toHaveLength(3);
  });

  it("scrubber updates currentFrameOrdinal", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 3 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1) });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 2, frame: mkFrame(2) });
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    const scrubber = screen.getByLabelText("Simulator frame scrubber") as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: "1" } });
    expect(useSimulatorStore.getState().currentFrameOrdinal).toBe(1);
  });

  it("renders Promote button only on fuzzy frames", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 3 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1, "primary") });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 2, frame: mkFrame(2, "fuzzy") });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 3, frame: mkFrame(3, "none") });
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    const promoteButtons = screen.queryAllByRole("button", { name: /promote/i });
    expect(promoteButtons).toHaveLength(1);
  });

  it("shows preview-off inline error and disables Run when previewEnabled=false", () => {
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId={null}
        previewEnabled={false}
      />,
    );
    expect(
      screen.getByText(/preview is off\. turn on preview/i),
    ).toBeInTheDocument();
    const runBtn = screen.getByRole("button", { name: /run simulator/i });
    expect(runBtn).toBeDisabled();
  });

  it("renders error bar when runState=failed", () => {
    useSimulatorStore
      .getState()
      .handleEvent({ type: "started", session_id: "s", run_id: "r", total_steps: 3 });
    useSimulatorStore
      .getState()
      .handleEvent({ type: "frame_captured", ordinal: 1, frame: mkFrame(1) });
    useSimulatorStore.getState().handleEvent({
      type: "failed",
      ordinal: 2,
      error_message: "selector not found",
    });
    render(
      <SimulatorTimeline
        projectFolder="/p"
        storyPath="/p/story.story"
        storySource=""
        streamId="stream-1"
        previewEnabled={true}
      />,
    );
    expect(screen.getByText(/selector not found/i)).toBeInTheDocument();
  });
});

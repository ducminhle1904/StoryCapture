import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  launchAutomation: vi.fn(),
  listCaptureTargets: vi.fn(),
  getCaptureTarget: vi.fn(),
  publishCompletedRecording: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/ipc/automation", () => ({ launchAutomation: mocks.launchAutomation }));
vi.mock("@/ipc/capture", () => ({
  captureTargetKey: (target: { kind: string; display_id?: number }) =>
    `${target.kind}:${target.display_id ?? ""}`,
  checkScreenCapturePermission: vi.fn(async () => ({ state: "granted" })),
  getCaptureTarget: mocks.getCaptureTarget,
  listCaptureTargets: mocks.listCaptureTargets,
  setCaptureTarget: vi.fn(async () => {}),
  requestScreenCaptureAccess: vi.fn(async () => ({ state: "granted" })),
  isStageManagerEnabled: vi.fn(async () => false),
  openScreenCapturePrefs: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("@/ipc/encode", () => ({
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
}));
vi.mock("@/ipc/parse", () => ({
  parseStory: vi.fn(async () => ({ ast: { scenes: [] } })),
}));
vi.mock("@/ipc/projects", () => ({ publishCompletedRecording: mocks.publishCompletedRecording }));
vi.mock("@/state/app-settings", () => {
  const useAppSettingsStore = (selector: (state: { settings: null }) => unknown) =>
    selector({ settings: null });
  useAppSettingsStore.getState = () => ({ settings: null });
  return { useAppSettingsStore };
});
vi.mock("@/state/output-prefs", () => ({
  applyCaptureFpsDefault: vi.fn(),
  DEFAULT_RECORDING_PACING: {},
  recordingOutputResolutionForStart: vi.fn(() => null),
  useOutputPrefsStore: {
    getState: () => ({
      activePreset: null,
      recordingKnobs: { fps: 30, fit: "contain", pad: "#000000", quality: "high" },
    }),
  },
}));
vi.mock("./recording-preview", () => ({ acquireRecordingPreview: vi.fn() }));
vi.mock("./AudioDevicePicker", () => ({ AudioDevicePicker: () => null }));
vi.mock("./ChromeHidingToggle", () => ({ ChromeHidingToggle: () => null }));
vi.mock("./CursorToggle", () => ({ CursorToggle: () => null }));
vi.mock("./tcc-prompt", () => ({ TccPrompt: () => null }));
vi.mock("./video-output/output-summary-badge", () => ({ OutputSummaryBadge: () => null }));
vi.mock("./video-output/video-output-section", () => ({
  useIsRecordingBlocked: () => false,
  VideoOutputSection: () => null,
}));

import { useRecorderStore } from "@/state/recorder";
import type { RecordingEvent } from "@/ipc/encode";

import { RecordingView } from "./recording-view";

const target = { kind: "display" as const, display_id: 7 };
const targets = {
  playwright_auto_available: false,
  displays: [
    {
      id: 7,
      name: "Main Display",
      width_px: 1920,
      height_px: 1080,
      x: 0,
      y: 0,
      scale_factor: 1,
      is_primary: true,
    },
  ],
  windows: [],
};

beforeEach(() => {
  useRecorderStore.getState().reset();
  useRecorderStore.setState({
    status: "completed",
    captureTarget: target,
    availableTargets: targets,
    outputPath: "/tmp/take-1.mp4",
  });
  mocks.startRecording.mockReset().mockResolvedValue({ id: "take-2" });
  mocks.stopRecording
    .mockReset()
    .mockResolvedValue({ output_path: "/tmp/stopped.mp4", duration_ms: 1 });
  mocks.launchAutomation.mockReset().mockResolvedValue(undefined);
  mocks.getCaptureTarget.mockReset().mockResolvedValue(target);
  mocks.listCaptureTargets.mockReset().mockResolvedValue(targets);
  mocks.publishCompletedRecording.mockReset();
});

afterEach(() => {
  cleanup();
  useRecorderStore.getState().reset();
});

describe("RecordingView take lifecycle", () => {
  it("preserves the target on New take and starts recording again without remount", async () => {
    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "native" }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    const start = await screen.findByRole("button", { name: "Start recording" });
    expect(start).toBeEnabled();
    expect(useRecorderStore.getState().captureTarget).toEqual(target);

    fireEvent.click(start);
    await waitFor(() => expect(mocks.startRecording).toHaveBeenCalledTimes(1));
    expect(useRecorderStore.getState().status).toBe("recording");
  });

  it("disables Start but allows Refresh to recover from a null target", async () => {
    let resolveTargets!: (value: typeof targets) => void;
    const pendingTargets = new Promise<typeof targets>((resolve) => {
      resolveTargets = resolve;
    });
    mocks.getCaptureTarget.mockResolvedValue(null);
    mocks.listCaptureTargets.mockReturnValue(pendingTargets);
    useRecorderStore.getState().resetTake();
    useRecorderStore.setState({ captureTarget: null, availableTargets: null });

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "native" }'}
        />
      </MemoryRouter>,
    );

    const start = screen.getByRole("button", { name: "Start recording" });
    expect(start).toBeDisabled();
    const refresh = await screen.findByRole("button", { name: "Refresh capture targets" });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);

    resolveTargets(targets);
    await waitFor(() => expect(start).toBeEnabled());
    expect(useRecorderStore.getState().captureTarget).toEqual(target);
  });

  it("replays a completion event emitted before startRecording resolves", async () => {
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
      onEvent({
        type: "completed",
        result: { output_path: "/tmp/early.mp4", duration_ms: 50 },
      });
      onEvent({
        type: "completed",
        result: { output_path: "/tmp/early.mp4", duration_ms: 50 },
      });
      return { id: "take-early" };
      },
    );

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "native" }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/early.mp4");
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
    expect(mocks.launchAutomation).not.toHaveBeenCalled();
  });

  it("clears the owned automation channel on completion", async () => {
    let recordingEvent!: (event: RecordingEvent) => void;
    const automationChannel = { onmessage: vi.fn() as ((event: unknown) => void) | null };
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        recordingEvent = onEvent;
        return { id: "take-owned" };
      },
    );
    mocks.launchAutomation.mockImplementation(async (_args, _onEvent, onChannel) => {
      onChannel(automationChannel);
    });

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "native" }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(mocks.launchAutomation).toHaveBeenCalledTimes(1));

    recordingEvent({
      type: "completed",
      result: { output_path: "/tmp/owned.mp4", duration_ms: 50 },
    });

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(automationChannel.onmessage).toBeNull();
  });

  it("publishes once when stop result and channel both complete the session", async () => {
    let recordingEvent!: (event: RecordingEvent) => void;
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        recordingEvent = onEvent;
        return { id: "take-duplicate" };
      },
    );

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "native" }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1));

    recordingEvent({
      type: "completed",
      result: { output_path: "/tmp/channel.mp4", duration_ms: 2 },
    });
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/stopped.mp4");
  });
});

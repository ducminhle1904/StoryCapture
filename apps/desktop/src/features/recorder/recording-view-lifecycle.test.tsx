import type { RecordingV4Event } from "@storycapture/shared-types/recording-v4";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  command: vi.fn(),
  recordAction: vi.fn(),
  releaseTerminal: vi.fn(),
  callbacks: null as null | { onEvent: (event: RecordingV4Event) => void },
  launchAutomation: vi.fn(),
  publishCompletedRecording: vi.fn(),
  parseStory: vi.fn(),
  listCaptureTargets: vi.fn(),
  getCaptureTarget: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn(), message: vi.fn(),
  }),
}));
vi.mock("@/ipc/automation", () => ({ launchAutomation: mocks.launchAutomation }));
vi.mock("@/ipc/capture", () => ({
  captureTargetKey: (target: { kind: string; display_id?: number }) => `${target.kind}:${target.display_id ?? ""}`,
  checkScreenCapturePermission: vi.fn(async () => ({ state: "granted" })),
  requestScreenCaptureAccess: vi.fn(async () => ({ state: "granted" })),
  getCaptureTarget: mocks.getCaptureTarget,
  listCaptureTargets: mocks.listCaptureTargets,
  setCaptureTarget: vi.fn(async () => undefined),
  isStageManagerEnabled: vi.fn(async () => false),
  openScreenCapturePrefs: vi.fn(async () => undefined),
  relaunchApp: vi.fn(async () => undefined),
}));
vi.mock("@/ipc/parse", () => ({ parseStory: mocks.parseStory }));
vi.mock("@/ipc/projects", () => ({ publishCompletedRecording: mocks.publishCompletedRecording }));
vi.mock("@/ipc/recording-failure", () => ({
  deleteFailedRecordingBundle: vi.fn(async () => undefined),
  openRecordingDiagnosticBundle: vi.fn(async () => undefined),
}));
vi.mock("@/state/app-settings", () => {
  const settings = {
    browser_executable: null,
    capture: { audio_input_default: "system_default", include_cursor_default: false },
  };
  const useAppSettingsStore = (selector: (state: { settings: typeof settings }) => unknown) => selector({ settings });
  useAppSettingsStore.getState = () => ({ settings });
  return { useAppSettingsStore };
});
vi.mock("@/state/output-prefs", () => ({
  applyCaptureFpsDefault: vi.fn(),
  DEFAULT_RECORDING_PACING: "normal",
}));
vi.mock("./use-recording-v4-session", () => ({
  useRecordingV4Session: (_projectPath: string, callbacks: typeof mocks.callbacks) => {
    mocks.callbacks = callbacks;
    return {
      start: mocks.start,
      command: mocks.command,
      recordAction: mocks.recordAction,
      releaseTerminal: mocks.releaseTerminal,
      sessionIdRef: { current: null },
    };
  },
}));

import { useRecorderStore } from "@/state/recorder";
import { queryClient } from "@/ipc/query-client";
import { RecordingView } from "./recording-view";

const target = { kind: "display" as const, display_id: 7 };
const targets = {
  playwright_auto_available: false,
  displays: [{ id: 7, name: "Main", width_px: 1920, height_px: 1080, x: 0, y: 0,
    scale_factor: 1, is_primary: true }],
  windows: [],
};

function renderView() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "https://example.test" }'}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callbacks = null;
  mocks.start.mockResolvedValue("session-1");
  mocks.command.mockResolvedValue(null);
  mocks.recordAction.mockResolvedValue(undefined);
  mocks.launchAutomation.mockReturnValue(new Promise(() => undefined));
  mocks.parseStory.mockResolvedValue({ ast: { scenes: [{ commands: [{ verb: "click" }] }] } });
  mocks.getCaptureTarget.mockResolvedValue(target);
  mocks.listCaptureTargets.mockResolvedValue(targets);
  useRecorderStore.getState().reset();
  useRecorderStore.setState({ captureTarget: target, availableTargets: targets });
});

afterEach(() => {
  cleanup();
  useRecorderStore.getState().reset();
});

describe("RecordingView V4 lifecycle", () => {
  it("starts only the verified 1080p60 coordinator path with native audio intent", async () => {
    useRecorderStore.setState({ audioDeviceId: "default" });
    renderView();
    expect(await screen.findByText("Verified 1080p · 60 fps")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      project_path: "/tmp/demo",
      source_url: "https://example.test/",
      logical_width: 960,
      logical_height: 540,
      requested_audio_roles: ["microphone"],
    })));
    expect(mocks.launchAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ recordingV4SessionId: "session-1" }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.launchAutomation.mock.calls[0]?.[0]).not.toHaveProperty("recordingSessionId");
  });

  it("shows truthful preflight and held-frame evidence", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(mocks.callbacks).not.toBeNull());
    mocks.callbacks?.onEvent({
      type: "preflight",
      result: {
        version: 4, profile: "verified_1080p60", platform: "darwin",
        target: { kind: "author_preview", stable_id: "preview", process_id: 42, initial_title: "Preview" },
        dimensions: { physical_width: 1920, physical_height: 1080 }, permission_granted: true,
        storage_available_bytes: 2, storage_required_bytes: 1, measured_write_bytes_per_second: 1,
        encoder: null, requested_audio_roles: [], available_audio_roles: [], passed: true, failure_codes: [],
      },
    });
    mocks.callbacks?.onEvent({
      type: "live-evidence",
      cadence: {
        version: 4, frame_rate: { numerator: 60, denominator: 1 }, active_duration_us: 33_333,
        expected_output_frames: 2, output_frames: 2, source_updates: 1, held_frames: 1,
        submitted_frames: 2, acknowledged_frames: 2, ring_high_water_mark: 1,
        pause_intervals: [], ledger: [], verdict: "passed", failure_codes: [],
      },
    });
    expect(await screen.findByText("Verified preflight passed")).toBeInTheDocument();
    expect(await screen.findByText("2 frames · 1 held")).toBeInTheDocument();
  });

  it("routes pause, resume, and stop intents only through the coordinator", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause recording" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("pause"));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("resume"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("stop"));
  });

  it("publishes completed V4 once and keeps quality failures out of discovery", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
    const completed = {
      version: 4 as const, profile: "verified_1080p60" as const, session_id: "session-1",
      state: "completed" as const, bundle_path: "/tmp/demo/exports/take.sc-recording",
      output_path: "/tmp/demo/exports/take.sc-recording/master/video.mp4",
      diagnostic_bundle_path: null, failure_codes: [] as [],
      sidecars: {
        actions_path: "/tmp/demo/exports/take.sc-recording/sidecars/actions.json",
        cursor_path: "/tmp/demo/exports/take.sc-recording/sidecars/cursor.json",
      },
    };
    mocks.callbacks?.onEvent({ type: "terminal", result: completed });
    mocks.callbacks?.onEvent({ type: "terminal", result: completed });
    await waitFor(() => expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1));
    expect(mocks.publishCompletedRecording).toHaveBeenCalledWith(expect.anything(), "project-1",
      expect.objectContaining({
        version: 4,
        width: 1920,
        height: 1080,
        actions_path: completed.sidecars.actions_path,
        cursor_path: completed.sidecars.cursor_path,
      }));
  });

  it("shows structured retry guidance for a failed quality gate", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
    mocks.callbacks?.onEvent({ type: "terminal", result: {
      version: 4, profile: "verified_1080p60", session_id: "session-1", state: "quality_failed",
      bundle_path: "/tmp/failed.sc-recording", output_path: null,
      diagnostic_bundle_path: "/tmp/failed.sc-recording", failure_codes: ["quality_checkpoint_failed"],
      sidecars: {
        actions_path: "/tmp/failed.sc-recording/sidecars/actions.json",
        cursor_path: "/tmp/failed.sc-recording/sidecars/cursor.json",
      },
    } });
    expect(await screen.findByText("Take was not published")).toBeInTheDocument();
    expect(screen.getByText("quality_checkpoint_failed")).toBeInTheDocument();
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});

import type { RecordingTerminalEventV1 } from "@storycapture/shared-types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  recordingPreflight: vi.fn(),
  getRecordingStatus: vi.fn(),
  stopRecording: vi.fn(),
  launchAutomation: vi.fn(),
  listCaptureTargets: vi.fn(),
  getCaptureTarget: vi.fn(),
  publishCompletedRecording: vi.fn(),
  openRetainedRecordingArtifact: vi.fn(),
  frontendLogInfo: vi.fn(),
  frontendLogWarn: vi.fn(),
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
  recordingPreflight: mocks.recordingPreflight,
  getRecordingStatus: mocks.getRecordingStatus,
  openRetainedRecordingArtifact: mocks.openRetainedRecordingArtifact,
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
}));
vi.mock("@/lib/log", () => ({
  frontendLog: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mocks.frontendLogInfo,
    warn: mocks.frontendLogWarn,
  },
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

import type { EngineHealthSnapshotDto, RecordingEvent } from "@/ipc/encode";
import { useRecorderStore } from "@/state/recorder";

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

type TerminalVerdict = RecordingTerminalEventV1["outcome"]["verdict"];

const terminalReason: Record<TerminalVerdict, RecordingTerminalEventV1["outcome"]["reason_code"]> =
  {
    passed: "passed",
    repairable: "automation_failed",
    failed: "encode_failed",
    cancelled: "cancelled_by_user",
  };

function terminalEvent(sessionId: string, verdict: TerminalVerdict): RecordingEvent {
  const outputPath = `/tmp/${sessionId}.mp4`;
  const artifact =
    verdict === "failed"
      ? null
      : {
          output_path: outputPath,
          duration_ms: 1_000,
          frame_count: 30,
          output_width: 1920,
          output_height: 1080,
        };
  const disposition =
    verdict === "passed"
      ? {
          show_complete: true,
          can_publish: true,
          auto_open_take: true,
          open_repair: false,
          retain_bundle: true,
        }
      : verdict === "repairable"
        ? {
            show_complete: false,
            can_publish: false,
            auto_open_take: false,
            open_repair: true,
            retain_bundle: true,
          }
        : {
            show_complete: false,
            can_publish: false,
            auto_open_take: false,
            open_repair: false,
            retain_bundle: verdict === "cancelled",
          };

  return {
    type: "terminal",
    terminal: {
      event: "terminal",
      version: 1,
      outcome: {
        version: 1,
        session_id: sessionId,
        verdict,
        reason_code: terminalReason[verdict],
        warnings: [],
        automation: {
          exit_reason:
            verdict === "passed" ? "completed" : verdict === "cancelled" ? "cancelled" : "failed",
          total_steps: 1,
          succeeded: verdict === "passed" ? 1 : 0,
          failed: verdict === "repairable" || verdict === "failed" ? 1 : 0,
          failed_ordinal: verdict === "repairable" || verdict === "failed" ? 1 : null,
        },
        capture: {
          output_path: artifact?.output_path ?? null,
          frames_written: artifact ? 30 : 0,
          frames_dropped: 0,
          cadence_warning: null,
          finalized: artifact !== null,
        },
      },
      disposition,
      artifact,
    },
  };
}

function engineHealthSnapshot(
  sessionId: string,
  sequence: number,
  overrides: Partial<EngineHealthSnapshotDto> = {},
): EngineHealthSnapshotDto {
  return {
    schema_version: 1,
    session_id: sessionId,
    sequence,
    observed_at_ms: 1,
    state: "stalled",
    reason_codes: ["encoder_not_alive"],
    requested_fps: 30,
    effective_fps: 30,
    actual_capture_fps: 29.8,
    source_capture_fps: 30,
    committed_frames: 60,
    source_frames_received: 61,
    frames_dropped: 1,
    skipped_ticks: 0,
    late_frames: 0,
    encoder_backpressured: false,
    encoder_backpressure_events: 1,
    capture_duration_ms_p95: 4,
    last_committed_pts_us: 2_000_000,
    encoder_alive: false,
    audio_tracks: [
      {
        track_id: "tab-main",
        role: "tab",
        requirement: "required",
        state: "healthy",
        samples_received: 60,
        last_sample_pts_us: 2_000_000,
        terminal_reason: null,
      },
    ],
    target_liveness: { state: "live", last_observed_at_ms: 1, reason: null },
    disk: { free_bytes: 1_000_000, threshold_bytes: 100_000, state: "ok" },
    terminal_health: { state: "fatal", reason_codes: ["encoder_not_alive"] },
    allowed_actions: ["cancel"],
    ...overrides,
  };
}

function strictStatus(sessionId: string, terminal: RecordingTerminalEventV1 | null) {
  return {
    version: 1,
    session_id: sessionId,
    snapshot: {
      version: 1,
      session_id: sessionId,
      state: terminal?.outcome.verdict === "cancelled" ? "cancelled" : "finalized",
      sequence: 2,
      updated_at: new Date(0).toISOString(),
    },
    terminal_outcome: terminal?.outcome ?? null,
    terminal_event: terminal,
    outcome_mode: "strict",
    cached_until: terminal ? new Date(60_000).toISOString() : null,
  };
}

function renderRecordingView(projectId: string | null = "project-1") {
  return render(
    <MemoryRouter>
      <RecordingView
        projectId={projectId}
        projectName="Demo"
        projectFolder="/tmp/demo"
        storySource={'meta { app: "native" }'}
      />
    </MemoryRouter>,
  );
}

async function beginRecording(sessionId: string): Promise<(event: RecordingEvent) => void> {
  let emit!: (event: RecordingEvent) => void;
  mocks.startRecording.mockImplementation(
    async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
      emit = onEvent;
      return { id: sessionId };
    },
  );

  renderRecordingView();
  fireEvent.click(screen.getByRole("button", { name: "New take" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
  await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
  return emit;
}

beforeEach(() => {
  window.sessionStorage.clear();
  useRecorderStore.getState().reset();
  useRecorderStore.setState({
    status: "completed",
    captureTarget: target,
    availableTargets: targets,
    outputPath: "/tmp/take-1.mp4",
  });
  mocks.startRecording.mockReset().mockResolvedValue({ id: "take-2" });
  mocks.recordingPreflight.mockReset().mockResolvedValue({
    version: 1,
    mode: "warn",
    checked_at: new Date(0).toISOString(),
    fingerprint: "test",
    verdict: "pass",
    checks: [],
    capabilities: {
      target: { kind: "display", electron_capture: "available", reason: "target_live" },
      capture_profile: { width: 1920, height: 1080, fps: 30, state: "available", reason: "test" },
      encoder: { state: "available", reason: "test" },
      audio: [],
    },
  });
  mocks.stopRecording
    .mockReset()
    .mockResolvedValue({ output_path: "/tmp/stopped.mp4", duration_ms: 1 });
  mocks.getRecordingStatus.mockReset().mockResolvedValue({
    version: 1,
    session_id: "legacy",
    snapshot: {
      version: 1,
      session_id: "legacy",
      state: "finalized",
      sequence: 1,
      updated_at: new Date(0).toISOString(),
    },
    terminal_outcome: null,
    terminal_event: null,
    outcome_mode: "legacy",
    cached_until: null,
  });
  mocks.launchAutomation.mockReset().mockResolvedValue(undefined);
  mocks.getCaptureTarget.mockReset().mockResolvedValue(target);
  mocks.listCaptureTargets.mockReset().mockResolvedValue(targets);
  mocks.publishCompletedRecording.mockReset();
  mocks.openRetainedRecordingArtifact.mockReset().mockResolvedValue(undefined);
  mocks.frontendLogInfo.mockReset();
  mocks.frontendLogWarn.mockReset();
});

afterEach(() => {
  cleanup();
  useRecorderStore.getState().reset();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("publishes a strict passed terminal", async () => {
    const sessionId = "strict-passed";
    const emit = await beginRecording(sessionId);

    emit(terminalEvent(sessionId, "passed"));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
    expect(mocks.publishCompletedRecording).toHaveBeenCalledWith(
      expect.anything(),
      "project-1",
      expect.objectContaining({
        path: `/tmp/${sessionId}.mp4`,
        duration_ms: 1_000,
        width: 1920,
        height: 1080,
      }),
    );
  });

  it.each([
    ["repairable", "repairable", "Recording needs repair"],
    ["cancelled", "cancelled", "Recording cancelled"],
    ["failed", "failed", "Recording failed"],
  ] as const)("does not publish a strict %s terminal", async (verdict, expectedStatus, expectedHeading) => {
    const sessionId = `strict-${verdict}`;
    const emit = await beginRecording(sessionId);

    emit(terminalEvent(sessionId, verdict));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe(expectedStatus));
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
    expect((await screen.findAllByText(expectedHeading)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Recording complete")).not.toBeInTheDocument();
  });

  it("suppresses a legacy completed event when status reports strict mode", async () => {
    const sessionId = "strict-legacy-completed";
    mocks.getRecordingStatus.mockResolvedValue(strictStatus(sessionId, null));
    const emit = await beginRecording(sessionId);

    emit({
      type: "completed",
      result: { output_path: "/tmp/legacy-completed.mp4", duration_ms: 50 },
    });

    await waitFor(() => expect(mocks.getRecordingStatus).toHaveBeenCalledWith({ id: sessionId }));
    expect(useRecorderStore.getState().status).toBe("recording");
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();

    emit(terminalEvent(sessionId, "repairable"));
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("repairable"));
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
  });

  it("keeps a strict legacy failure diagnostic until the terminal arrives", async () => {
    const sessionId = "strict-failed-before-terminal";
    mocks.getRecordingStatus.mockResolvedValue(strictStatus(sessionId, null));
    const emit = await beginRecording(sessionId);

    emit({ type: "failed", message: "legacy encoder failure" });

    await waitFor(() => expect(mocks.getRecordingStatus).toHaveBeenCalledWith({ id: sessionId }));
    expect(useRecorderStore.getState().status).toBe("recording");
    expect(useRecorderStore.getState().sessionId).toBe(sessionId);
    expect(useRecorderStore.getState().error).toContain("authoritative outcome is pending");
    expect(window.sessionStorage.length).toBe(1);

    emit(terminalEvent(sessionId, "repairable"));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("repairable"));
    expect(useRecorderStore.getState().outputPath).toBe(`/tmp/${sessionId}.mp4`);
    expect(window.sessionStorage.length).toBe(0);
    expect(
      await screen.findByText("Open the retained take in its default app for manual repair."),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open retained artifact for manual repair" }),
    );
    await waitFor(() =>
      expect(mocks.openRetainedRecordingArtifact).toHaveBeenCalledWith(`/tmp/${sessionId}.mp4`),
    );
  });

  it("handles recording outcome shadow events as diagnostics on the recording channel", async () => {
    const sessionId = "shadow-diagnostic";
    const emit = await beginRecording(sessionId);
    const terminal = terminalEvent(sessionId, "repairable");
    if (terminal.type !== "terminal") throw new Error("expected terminal fixture");

    emit({ type: "recording_outcome_shadow", outcome: terminal.terminal.outcome });

    await waitFor(() =>
      expect(mocks.frontendLogInfo).toHaveBeenCalledWith(
        "RecordingView",
        "recording outcome shadow diagnostic",
        expect.objectContaining({
          fields: expect.objectContaining({ session_id: sessionId, verdict: "repairable" }),
        }),
      ),
    );
    expect(useRecorderStore.getState().status).toBe("recording");
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
  });

  it("renders a persistent accessible health panel and rejects stale action updates", async () => {
    const sessionId = "health-current";
    const emit = await beginRecording(sessionId);

    emit({ type: "health-update", snapshot: engineHealthSnapshot(sessionId, 2) });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Engine stalled");
    expect(alert).toHaveTextContent("encoder not alive");
    expect(screen.getByRole("status", { name: /Engine stalled.*encoder not alive/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair" })).not.toBeInTheDocument();

    emit({
      type: "health-update",
      snapshot: engineHealthSnapshot("health-stale", 3, {
        state: "healthy",
        reason_codes: [],
        encoder_alive: true,
        terminal_health: { state: "none", reason_codes: [] },
        allowed_actions: ["stop", "repair"],
      }),
    });
    emit({
      type: "health-update",
      snapshot: engineHealthSnapshot(sessionId, 1, { allowed_actions: ["stop", "repair"] }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Engine stalled");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair" })).not.toBeInTheDocument();
  });

  it("reattaches after remount and consumes the cached strict terminal", async () => {
    const sessionId = "strict-remount-terminal";
    let emit!: (event: RecordingEvent) => void;
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        emit = onEvent;
        return { id: sessionId };
      },
    );
    const firstView = renderRecordingView();
    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
    expect(emit).toBeTypeOf("function");
    expect(window.sessionStorage.length).toBe(1);
    const persistedKey = window.sessionStorage.key(0);
    const persistedValue = persistedKey ? window.sessionStorage.getItem(persistedKey) : null;
    if (!persistedValue) throw new Error("expected persisted recording session");
    expect(JSON.parse(persistedValue)).toEqual({
      version: 1,
      session_id: sessionId,
      project_id: "project-1",
    });

    const terminal = terminalEvent(sessionId, "passed");
    if (terminal.type !== "terminal") throw new Error("expected terminal fixture");
    mocks.getRecordingStatus.mockResolvedValue(strictStatus(sessionId, terminal.terminal));
    firstView.unmount();

    renderRecordingView();

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(mocks.getRecordingStatus).toHaveBeenCalledWith({ id: sessionId });
    expect(useRecorderStore.getState().outputPath).toBe(`/tmp/${sessionId}.mp4`);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not reattach a persisted session owned by another project", async () => {
    const sessionId = "other-project-session";
    mocks.startRecording.mockResolvedValue({ id: sessionId });
    const firstView = renderRecordingView();
    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
    firstView.unmount();
    mocks.getRecordingStatus.mockClear();

    renderRecordingView("project-2");
    await screen.findByRole("button", { name: "Start recording" });

    expect(mocks.getRecordingStatus).not.toHaveBeenCalled();
    expect(useRecorderStore.getState().sessionId).toBeNull();
    expect(window.sessionStorage.length).toBe(1);
  });

  it("keeps Force stop ownership until it consumes the cached terminal", async () => {
    let watchdogTick: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 1_000 && typeof handler === "function") {
        watchdogTick = handler as () => void;
      }
      return 777_777;
    }) as typeof window.setInterval);

    const sessionId = "strict-force-stop";
    const emit = await beginRecording(sessionId);
    const terminal = terminalEvent(sessionId, "cancelled");
    if (terminal.type !== "terminal") throw new Error("expected terminal fixture");
    mocks.getRecordingStatus.mockResolvedValue(strictStatus(sessionId, terminal.terminal));

    const heartbeatAt = Date.now();
    emit({ type: "heartbeat", seq: 1 });
    vi.spyOn(Date, "now").mockReturnValue(heartbeatAt + 6_000);
    act(() => watchdogTick?.());

    fireEvent.click(await screen.findByRole("button", { name: "Force stop" }));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("cancelled"));
    expect(mocks.stopRecording).toHaveBeenCalledWith({ id: sessionId });
    expect(mocks.getRecordingStatus).toHaveBeenCalledWith({ id: sessionId });
    expect(useRecorderStore.getState().outputPath).toBe(`/tmp/${sessionId}.mp4`);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("consumes a cached strict terminal when the live event was missed", async () => {
    const sessionId = "strict-cached-terminal";
    const terminal = terminalEvent(sessionId, "passed");
    if (terminal.type !== "terminal") throw new Error("expected terminal fixture");
    mocks.getRecordingStatus.mockResolvedValue(strictStatus(sessionId, terminal.terminal));
    await beginRecording(sessionId);

    fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(mocks.getRecordingStatus).toHaveBeenCalledWith({ id: sessionId });
    expect(useRecorderStore.getState().outputPath).toBe(`/tmp/${sessionId}.mp4`);
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
  });
});

import type {
  RecordingPreflightV3Dto,
  RecordingResultV3,
} from "@storycapture/shared-types/recording-v2";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  probeRecordingV3Capability: vi.fn(),
  queryRecordingV3Sessions: vi.fn(),
  reattachRecordingV3: vi.fn(),
  acknowledgeRecordingV3: vi.fn(),
  launchAutomation: vi.fn(),
  listCaptureTargets: vi.fn(),
  getCaptureTarget: vi.fn(),
  publishCompletedRecording: vi.fn(),
  acquireRecordingPreview: vi.fn(),
  parseStory: vi.fn(),
  deleteFailedRecordingBundle: vi.fn(),
  openRecordingDiagnosticBundle: vi.fn(),
  outputPrefs: {
    recordingDeliveryPolicy: "best_effort" as "best_effort" | "strict",
    recordingV3DevelopmentMode: false,
  },
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
  acknowledgeRecordingV3: mocks.acknowledgeRecordingV3,
  pauseRecording: vi.fn(),
  probeRecordingV3Capability: mocks.probeRecordingV3Capability,
  queryRecordingV3Sessions: mocks.queryRecordingV3Sessions,
  reattachRecordingV3: mocks.reattachRecordingV3,
  resumeRecording: vi.fn(),
  startRecording: mocks.startRecording,
  stopRecording: mocks.stopRecording,
}));
vi.mock("@/ipc/parse", () => ({
  parseStory: mocks.parseStory,
}));
vi.mock("@/ipc/projects", () => ({ publishCompletedRecording: mocks.publishCompletedRecording }));
vi.mock("@/ipc/recording-failure", () => ({
  deleteFailedRecordingBundle: mocks.deleteFailedRecordingBundle,
  openRecordingDiagnosticBundle: mocks.openRecordingDiagnosticBundle,
}));
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
  useOutputPrefsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        ...mocks.outputPrefs,
      }),
    {
      getState: () => ({
        activePreset: null,
        ...mocks.outputPrefs,
        recordingKnobs: { fps: 30, fit: "contain", pad: "#000000", quality: "high" },
      }),
    },
  ),
}));
vi.mock("./recording-preview", () => ({
  acquireRecordingPreview: mocks.acquireRecordingPreview,
}));
vi.mock("./AudioDevicePicker", () => ({ AudioDevicePicker: () => null }));
vi.mock("./ChromeHidingToggle", () => ({ ChromeHidingToggle: () => null }));
vi.mock("./CursorToggle", () => ({ CursorToggle: () => null }));
vi.mock("./tcc-prompt", () => ({ TccPrompt: () => null }));
vi.mock("./video-output/output-summary-badge", () => ({ OutputSummaryBadge: () => null }));
vi.mock("./video-output/video-output-section", () => ({
  useIsRecordingBlocked: () => false,
  VideoOutputSection: () => null,
}));

import type { RecordingEvent } from "@/ipc/encode";
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

const v3Preflight = {
  version: 3,
  intent: "strict",
  recording_mode: "certified",
  backend_id: "electron_offscreen_shared_texture_v3",
  backend_version: "3.0.0",
  addon_protocol_version: 3,
  platform: "darwin",
  arch: "arm64",
  hardware_model: "Mac17,2",
  hardware_chip: "Apple M5",
  os_build: "25F84",
  manifest_id: "manifest-1",
  matched_profile: null,
  source_rate: {
    measured_fps: { numerator: 60, denominator: 1 },
    source_presentations: 60,
    sequence_gaps: 0,
    stale_reuses: 0,
    probe_duration_ms: 1_000,
  },
  storage: {
    estimated_bytes_per_second: 1,
    required_bytes_for_ten_minutes: 600,
    available_bytes: 10_000,
    reserve_bytes: 1_000,
  },
  native_probe_passed: true,
  permissions_granted: true,
  strict_eligible: true,
  development_eligible: false,
  failure_codes: [],
} satisfies RecordingPreflightV3Dto;

const v3DevelopmentPreflight = {
  ...v3Preflight,
  intent: "development",
  recording_mode: "uncertified_development",
  manifest_id: null,
  matched_profile: null,
  strict_eligible: false,
  development_eligible: true,
} satisfies RecordingPreflightV3Dto;

const v3QualityFailure = {
  version: 3,
  status: "quality_failed",
  delivery_policy: "strict",
  recording_mode: "certified",
  guarantee_boundary: "electron_offscreen_delivery",
  certification_profile: null,
  bundle_path: "/tmp/demo/exports/v3-failed.sc-recording",
  output_path: null,
  diagnostic_bundle_path: "/tmp/demo/exports/v3-failed.sc-recording",
  duration_ms: 1_000,
  bytes: 1,
  master_path: null,
  proxy_path: null,
  cadence_evidence: {
    version: 3,
    guarantee_boundary: "electron_offscreen_delivery",
    source_ordinal_kind: "electron_frame_count",
    requested_fps: { numerator: 60, denominator: 1 },
    source_fps: { numerator: 60, denominator: 1 },
    stream_time_base: { numerator: 1, denominator: 60 },
    active_duration_us: 1_000_000,
    expected_slots: 60,
    source_presentations: 60,
    delivery_frames: 60,
    native_commits: 60,
    encoded_frames: 60,
    artifact_decoded_frames: 0,
    source_ordinal_gaps: 0,
    source_timestamp_regressions: 0,
    delivery_duplicates: 0,
    native_lease_overflows: 0,
    native_backpressure_events: 0,
    native_deadline_misses: 0,
    artifact_pts_gaps: 0,
    artifact_pts_duplicates: 0,
    full_decode_succeeded: false,
    verdict: "failed",
    failure_codes: ["artifact_verification_failed"],
  },
  quality_evidence: {
    version: 3,
    measurement_scope: "runtime_integrity",
    reference_identity: null,
    evaluated_frames: 0,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes_match: false,
    certification_verdict: null,
    verdict: "failed",
    failure_codes: ["artifact_verification_failed"],
  },
} satisfies RecordingResultV3;

beforeEach(() => {
  mocks.outputPrefs.recordingDeliveryPolicy = "best_effort";
  mocks.outputPrefs.recordingV3DevelopmentMode = false;
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
  mocks.probeRecordingV3Capability.mockReset();
  mocks.queryRecordingV3Sessions.mockReset().mockResolvedValue([]);
  mocks.reattachRecordingV3.mockReset().mockResolvedValue(null);
  mocks.acknowledgeRecordingV3.mockReset().mockResolvedValue(true);
  mocks.launchAutomation.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.acquireRecordingPreview.mockReset();
  mocks.parseStory.mockReset().mockResolvedValue({ ast: { scenes: [] } });
  mocks.getCaptureTarget.mockReset().mockResolvedValue(target);
  mocks.listCaptureTargets.mockReset().mockResolvedValue(targets);
  mocks.publishCompletedRecording.mockReset();
  mocks.deleteFailedRecordingBundle.mockReset().mockResolvedValue(undefined);
  mocks.openRecordingDiagnosticBundle.mockReset().mockResolvedValue(undefined);
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

  it("routes Dev V3 through development admission and keeps provenance in publication", async () => {
    mocks.outputPrefs.recordingV3DevelopmentMode = true;
    mocks.probeRecordingV3Capability.mockResolvedValue(v3DevelopmentPreflight);
    mocks.acquireRecordingPreview.mockResolvedValue({ streamId: "preview-dev", release: vi.fn() });
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        onEvent({
          type: "completed",
          result: {
            ...v3QualityFailure,
            status: "completed",
            delivery_policy: "development",
            recording_mode: "uncertified_development",
            certification_profile: null,
            bundle_path: "/tmp/demo/exports/dev.sc-recording",
            master_path: "/tmp/demo/exports/dev.sc-recording/master/video.mkv",
            proxy_path: "/tmp/demo/exports/dev.sc-recording/proxy/video.mp4",
            output_path: "/tmp/demo/exports/dev.sc-recording/proxy/video.mp4",
            diagnostic_bundle_path: null,
            cadence_evidence: {
              ...v3QualityFailure.cadence_evidence,
              artifact_decoded_frames: 60,
              full_decode_succeeded: true,
              verdict: "passed",
              failure_codes: [],
            },
            quality_evidence: {
              ...v3QualityFailure.quality_evidence,
              evaluated_frames: 60,
              lossless_master_hashes_match: true,
              verdict: "passed",
              failure_codes: [],
            },
          },
        });
        return { id: "take-dev-v3" };
      },
    );

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "https://example.com" viewport: 960x540 }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(mocks.probeRecordingV3Capability).toHaveBeenCalledTimes(1));
    expect(mocks.probeRecordingV3Capability).toHaveBeenCalledWith(
      expect.objectContaining({
        contract_version: 3,
        intent: "development",
        delivery_policy: "development",
        fps: 60,
      }),
    );
    await waitFor(() => expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1));
    expect(mocks.publishCompletedRecording).toHaveBeenCalledWith(
      expect.anything(),
      "project-1",
      expect.objectContaining({
        version: 3,
        recording_mode: "uncertified_development",
        bundle_path: "/tmp/demo/exports/dev.sc-recording",
        master_path: "/tmp/demo/exports/dev.sc-recording/master/video.mkv",
        frame_ledger_path: "/tmp/demo/exports/dev.sc-recording/evidence/frame-ledger.jsonl",
        source_frame_count: 60,
        source_scope_verified: true,
      }),
    );
    expect(
      screen.getByText("Uncertified Development — not a Strict-certified recording"),
    ).toBeInTheDocument();
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
    mocks.launchAutomation.mockImplementation((_args, _onEvent, onChannel) => {
      onChannel(automationChannel);
      return new Promise(() => {});
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

  it("keeps a quality-failed Strict take out of project publication", async () => {
    let recordingEvent!: (event: RecordingEvent) => void;
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        recordingEvent = onEvent;
        return { id: "take-quality-failed" };
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
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));

    recordingEvent({ type: "verifying", progress: 0.5 });
    await waitFor(() => expect(useRecorderStore.getState().status).toBe("verifying"));
    recordingEvent({
      type: "quality-failed",
      result: {
        version: 2,
        status: "quality_failed",
        delivery_policy: "strict",
        certified_tier: null,
        bundle_path: "/tmp/demo/exports/failed.sc-recording",
        output_path: null,
        diagnostic_bundle_path: "/tmp/demo/exports/failed.sc-recording",
        duration_ms: 50,
        bytes: 1,
        master_path: null,
        proxy_path: null,
        cadence_evidence: {
          version: 2,
          requested_fps: { numerator: 60, denominator: 1 },
          source_fps: { numerator: 60, denominator: 1 },
          stream_time_base: { numerator: 1, denominator: 60 },
          active_duration_us: 50_000,
          expected_slots: 3,
          source_presentations: 3,
          submitted_frames: 3,
          encoder_acked_frames: 2,
          artifact_decoded_frames: 2,
          source_sequence_gaps: 0,
          stale_reuses: 0,
          skipped_slots: 0,
          dropped_frames: 1,
          deadline_misses: 0,
          ring_overflows: 0,
          backpressure_events: 0,
          pts_gaps: 0,
          pts_duplicates: 0,
          full_decode_succeeded: true,
          verdict: "failed",
          failure_codes: ["submitted_frame_dropped"],
        },
        quality_evidence: {
          version: 2,
          evaluated_frames: 0,
          full_frame_luma_ssim: null,
          text_edge_roi_ssim: null,
          p01_edge_contrast_retention: null,
          edge_spread_increase_px: null,
          overlay_geometry_delta_px: null,
          color_channel_delta: null,
          lossless_master_hashes_match: false,
          verdict: "failed",
          failure_codes: ["artifact_hash_mismatch"],
        },
      },
    });

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("quality_failed"));
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
    expect(screen.getByText("Strict take was not published")).toBeInTheDocument();
  });

  it("reattaches an active V3 host session after a renderer reload without stopping it", async () => {
    mocks.queryRecordingV3Sessions.mockResolvedValue([
      {
        version: 3,
        id: "take-v3-active",
        project_folder: "/tmp/demo",
        started_at_ms: Date.now() - 500,
        lifecycle: "recording",
        preflight: v3Preflight,
        result: null,
        failure_codes: [],
        failure_message: null,
        updated_at: new Date().toISOString(),
      },
    ]);

    const view = render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "https://example.com" viewport: 960x540 }'}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("recording"));
    expect(mocks.reattachRecordingV3).toHaveBeenCalledWith("take-v3-active", expect.any(Function));
    view.unmount();
    expect(mocks.stopRecording).not.toHaveBeenCalled();
  });

  it("acknowledges a reattached V3 quality failure without publishing it", async () => {
    mocks.queryRecordingV3Sessions.mockResolvedValue([
      {
        version: 3,
        id: "take-v3-quality-failed",
        project_folder: "/tmp/demo",
        started_at_ms: Date.now() - 1_000,
        lifecycle: "terminal_unacknowledged",
        preflight: v3Preflight,
        result: v3QualityFailure,
        failure_codes: ["artifact_verification_failed"],
        failure_message: null,
        updated_at: new Date().toISOString(),
      },
    ]);

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "https://example.com" viewport: 960x540 }'}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("quality_failed"));
    expect(mocks.publishCompletedRecording).not.toHaveBeenCalled();
    expect(mocks.acknowledgeRecordingV3).toHaveBeenCalledWith("take-v3-quality-failed");
  });

  it("finalizes from the returned automation outcome when channel events are missing", async () => {
    const release = vi.fn();
    mocks.acquireRecordingPreview.mockResolvedValue({ streamId: "preview-1", release });
    mocks.launchAutomation.mockResolvedValue({
      story: {
        total_steps: 1,
        succeeded: 1,
        failed: 0,
        duration_ms: 50,
        exit_reason: "completed",
        failed_ordinal: null,
      },
      recording: {
        status: "finalized",
        result: { output_path: "/tmp/outcome.mp4", duration_ms: 50 },
      },
    });

    render(
      <MemoryRouter>
        <RecordingView
          projectId="project-1"
          projectName="Demo"
          projectFolder="/tmp/demo"
          storySource={'meta { app: "https://example.com" }'}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New take" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/outcome.mp4");
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("publishes once when completion arrives through both event and returned outcome", async () => {
    let recordingEvent!: (event: RecordingEvent) => void;
    mocks.startRecording.mockImplementation(
      async (_args: unknown, onEvent: (event: RecordingEvent) => void) => {
        recordingEvent = onEvent;
        return { id: "take-event-outcome" };
      },
    );
    mocks.launchAutomation.mockImplementation(async () => {
      recordingEvent({
        type: "completed",
        result: { output_path: "/tmp/event.mp4", duration_ms: 40 },
      });
      return {
        story: {
          total_steps: 1,
          succeeded: 1,
          failed: 0,
          duration_ms: 40,
          exit_reason: "completed",
          failed_ordinal: null,
        },
        recording: {
          status: "finalized",
          result: { output_path: "/tmp/outcome.mp4", duration_ms: 40 },
        },
      };
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

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/event.mp4");
  });

  it("lets the returned finalized outcome win a manual-stop NotFound race", async () => {
    let resolveOutcome!: (value: unknown) => void;
    mocks.launchAutomation.mockReturnValue(
      new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    );
    mocks.stopRecording.mockRejectedValue(
      new Error("Error invoking remote method 'tauri-invoke': recording session take-2 not found"),
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
    await waitFor(() => expect(mocks.stopRecording).toHaveBeenCalledTimes(1));

    resolveOutcome({
      story: {
        total_steps: 1,
        succeeded: 1,
        failed: 0,
        duration_ms: 30,
        exit_reason: "completed",
        failed_ordinal: null,
      },
      recording: {
        status: "finalized",
        result: { output_path: "/tmp/race.mp4", duration_ms: 30 },
      },
    });

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/race.mp4");
    expect(mocks.publishCompletedRecording).toHaveBeenCalledTimes(1);
  });

  it("marks the failed ordinal from the returned outcome when step events are missing", async () => {
    mocks.parseStory.mockResolvedValue({
      ast: { scenes: [{ commands: [{ verb: "navigate" }, { verb: "wait-for" }] }] },
    });
    mocks.launchAutomation.mockResolvedValue({
      story: {
        total_steps: 2,
        succeeded: 1,
        failed: 1,
        duration_ms: 30,
        exit_reason: "failed",
        failed_ordinal: 2,
      },
      recording: {
        status: "finalized",
        result: { output_path: "/tmp/failed-story.mp4", duration_ms: 30 },
      },
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
    await waitFor(() => expect(useRecorderStore.getState().steps).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(useRecorderStore.getState().status).toBe("completed"));
    expect(useRecorderStore.getState().steps[1]?.status).toBe("failed");
    expect(useRecorderStore.getState().outputPath).toBe("/tmp/failed-story.mp4");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
  reserve: vi.fn(),
  runComposited: vi.fn(),
  sourceHasAudio: vi.fn(),
  verify: vi.fn(),
  renderSessions: new Map<string, unknown>(),
  renderProgressListeners: new Set<unknown>(),
  sendChannel: vi.fn(),
}));

vi.mock("./capture-preview", () => ({
  clampFps: (value: unknown) => Math.max(1, Math.min(240, Math.round(Number(value) || 60))),
}));

vi.mock("./export-compositor", () => ({
  runCompositedExportForRenderSession: mocks.runComposited,
}));

vi.mock("./export-artifact-verification", () => ({
  sourceHasAudio: mocks.sourceHasAudio,
  verifyExportArtifact: mocks.verify,
}));

vi.mock("./export-output-lifecycle", () => ({
  commitExportOutput: mocks.commit,
  prepareExportOutputFolder: mocks.prepare,
  releaseExportOutput: mocks.release,
  reserveExportOutputPath: mocks.reserve,
}));

vi.mock("./shared", () => ({
  channelIdFrom: () => null,
  renderProgressListeners: mocks.renderProgressListeners,
  renderSessions: mocks.renderSessions,
  sendChannel: mocks.sendChannel,
}));

import type { ExportOutputReservation } from "./export-output-lifecycle";
import {
  analyzeExportPlan,
  enqueueExportRenderJob,
  renderCancel,
  renderListActive,
  renderProgress,
} from "./export-render";
import type { ExportOutput, RenderJob, RenderSession } from "./shared";

function output(overrides: Partial<ExportOutput> = {}): ExportOutput {
  return {
    format: "mp4",
    resolution: "720p",
    fps: 30,
    quality: "high",
    encoder_options: {
      container: "mp4",
      codec: "h264",
      rate_control: "crf",
      hw_encoder: "libx264-software",
      quality_value: 18,
      x264_preset: "medium",
      keyframe_interval_sec: 2,
      downscale_algo: "lanczos",
      audio: {
        codec: "aac",
        bitrate_kbps: 160,
        channels: 2,
        sample_rate_hz: 48_000,
      },
    },
    ...overrides,
  };
}

function graphJson(): string {
  return JSON.stringify({
    schema_version: 4,
    output_width: 1280,
    output_height: 720,
    output_fps: 30,
    duration_ms: 1_000,
    video: [
      {
        type: "source",
        id: "source-1",
        clip_id: "clip-1",
        path: "/tmp/source.mp4",
        pts_offset_ms: 0,
        timeline_start_ms: 0,
        duration_ms: 1_000,
        source_width: 1280,
        source_height: 720,
      },
    ],
    audio: [],
  });
}

function planFor(cfg = output()) {
  const plan = analyzeExportPlan(graphJson(), cfg);
  if (plan.kind === "unsupported") throw new Error(plan.reason);
  return plan;
}

function reservation(jobId: string): ExportOutputReservation {
  return {
    finalPath: `/tmp/${jobId}.mp4`,
    tempPath: `/tmp/.${jobId}.part.mp4`,
    reservationPath: `/tmp/${jobId}.mp4.storycapture-reservation.json`,
  };
}

function session(jobId: string): RenderSession | undefined {
  return mocks.renderSessions.get(jobId) as RenderSession | undefined;
}

async function expectStatus(jobId: string, status: RenderJob["status"]): Promise<void> {
  await vi.waitFor(() => expect(session(jobId)?.job.status).toBe(status));
}

beforeEach(() => {
  mocks.renderSessions.clear();
  mocks.renderProgressListeners.clear();
  vi.clearAllMocks();
  mocks.commit.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.sourceHasAudio.mockResolvedValue(false);
  mocks.verify.mockResolvedValue(undefined);
  mocks.runComposited.mockImplementation(
    async (
      activeSession: RenderSession,
      _plan: unknown,
      onProgress: (frame: number) => void,
      _ffmpegArgs: string[],
      onFramesComplete: () => void,
    ) => {
      activeSession.frame = 30;
      onProgress(30);
      onFramesComplete();
    },
  );
});

describe("export render orchestration", () => {
  it("does not complete or commit until artifact verification succeeds", async () => {
    let finishVerification: (() => void) | undefined;
    mocks.verify.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishVerification = resolve;
        }),
    );
    const outputReservation = reservation("verified-job");

    enqueueExportRenderJob({
      id: "verified-job",
      batchId: "batch-1",
      storyId: "story-1",
      output: output(),
      plan: planFor(),
      outputReservation,
    });

    await expectStatus("verified-job", "verifying");
    expect(mocks.commit).not.toHaveBeenCalled();
    finishVerification?.();
    await expectStatus("verified-job", "completed");
    expect(mocks.commit).toHaveBeenCalledWith(outputReservation);
    expect(session("verified-job")?.job.output_path).toBe(outputReservation.finalPath);
  });

  it("isolates failures between runtime jobs in one batch", async () => {
    mocks.runComposited.mockImplementation(
      async (
        activeSession: RenderSession,
        _plan: unknown,
        _onProgress: (frame: number) => void,
        _ffmpegArgs: string[],
        onFramesComplete: () => void,
      ) => {
        if (activeSession.job.id === "failed-job") throw new Error("synthetic encoder failure");
        onFramesComplete();
      },
    );
    const failedReservation = reservation("failed-job");
    const completedReservation = reservation("completed-job");

    for (const [id, outputReservation] of [
      ["failed-job", failedReservation],
      ["completed-job", completedReservation],
    ] as const) {
      enqueueExportRenderJob({
        id,
        batchId: "batch-2",
        storyId: "story-1",
        output: output(),
        plan: planFor(),
        outputReservation,
      });
    }

    await Promise.all([
      expectStatus("failed-job", "failed"),
      expectStatus("completed-job", "completed"),
    ]);
    expect(mocks.release).toHaveBeenCalledWith(failedReservation);
    expect(mocks.commit).toHaveBeenCalledWith(completedReservation);
    expect(session("failed-job")?.job.error).toContain("synthetic encoder failure");
  });

  it("cancels active work, releases partial output, and preserves terminal jobs", async () => {
    let finishRender: (() => void) | undefined;
    mocks.runComposited.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRender = resolve;
        }),
    );
    const outputReservation = reservation("cancel-job");

    enqueueExportRenderJob({
      id: "cancel-job",
      batchId: "batch-3",
      storyId: "story-1",
      output: output(),
      plan: planFor(),
      outputReservation,
    });
    await expectStatus("cancel-job", "rendering");
    renderCancel("cancel-job");
    expect(session("cancel-job")?.job.status).toBe("cancelled");
    finishRender?.();
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledWith(outputReservation));
    expect(mocks.commit).not.toHaveBeenCalled();

    renderCancel("cancel-job");
    expect(session("cancel-job")?.job.status).toBe("cancelled");
    expect(renderListActive("story-1").map((job) => job.id)).toContain("cancel-job");
  });

  it("does not start the compositor after cancellation during source probing", async () => {
    let finishProbe: (() => void) | undefined;
    const probeSourceAudio = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = () => resolve(false);
        }),
    );
    const outputReservation = reservation("cancel-probe-job");

    enqueueExportRenderJob({
      id: "cancel-probe-job",
      batchId: "batch-4",
      storyId: "story-1",
      output: output(),
      plan: planFor(),
      outputReservation,
      probeSourceAudio,
    });
    await vi.waitFor(() => expect(probeSourceAudio).toHaveBeenCalled());
    renderCancel("cancel-probe-job");
    finishProbe?.();

    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledWith(outputReservation));
    expect(mocks.runComposited).not.toHaveBeenCalled();
    expect(session("cancel-probe-job")?.job.status).toBe("cancelled");
  });

  it("exposes status and phase progress through the shared DTO", () => {
    const job = {
      id: "progress-job",
      status: "mixing",
      progress_pct: 90,
      phase_progress_pct: 50,
      fps: 30,
    } as RenderJob;

    expect(renderProgress(job, 30)).toMatchObject({
      job_id: "progress-job",
      status: "mixing",
      pct: 90,
      phase_pct: 50,
      frame: 30,
    });
  });
});

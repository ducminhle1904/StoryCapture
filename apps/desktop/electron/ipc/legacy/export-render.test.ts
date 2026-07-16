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
        bitrate_kbps: 192,
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

function requiredSession(jobId: string): RenderSession {
  const value = session(jobId);
  if (!value) throw new Error(`missing render session: ${jobId}`);
  return value;
}

function installControlledCompositor() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  mocks.runComposited.mockImplementation(
    (
      activeSession: RenderSession,
      _plan: unknown,
      _onProgress: (frame: number) => void,
      _ffmpegArgs: string[],
      onFramesComplete: () => void,
    ) => {
      started.push(activeSession.job.id);
      return new Promise<void>((resolve) => {
        finish.set(activeSession.job.id, () => {
          onFramesComplete();
          resolve();
        });
      });
    },
  );
  return { finish, started };
}

function enqueueTestJob(args: {
  id: string;
  output?: ExportOutput;
  priority?: number;
  probeSourceAudio?: (path: string) => Promise<boolean>;
  analyzeLoudness?: (ffmpegArgs: string[], session: RenderSession) => Promise<string>;
}): ExportOutputReservation {
  const cfg = args.output ?? output();
  const outputReservation = reservation(args.id);
  enqueueExportRenderJob({
    id: args.id,
    batchId: "scheduler-batch",
    storyId: "story-1",
    output: cfg,
    plan: planFor(cfg),
    outputReservation,
    priority: args.priority,
    probeSourceAudio: args.probeSourceAudio,
    analyzeLoudness: args.analyzeLoudness,
  });
  return outputReservation;
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
  it("never consumes more than two scheduler units", async () => {
    const controlled = installControlledCompositor();
    const oneUnitBoundaryOutput = output({
      resolution: "custom",
      output_width: 2560,
      output_height: 1440,
    });

    for (const id of ["capacity-first", "capacity-second", "capacity-third"]) {
      enqueueTestJob({ id, output: oneUnitBoundaryOutput });
    }

    await vi.waitFor(() =>
      expect(controlled.started).toEqual(["capacity-first", "capacity-second"]),
    );
    expect(session("capacity-third")?.job).toMatchObject({
      status: "queued",
      queue_position: 1,
      started_at: null,
    });

    controlled.finish.get("capacity-first")?.();
    await vi.waitFor(() =>
      expect(controlled.started).toEqual(["capacity-first", "capacity-second", "capacity-third"]),
    );
    controlled.finish.get("capacity-second")?.();
    controlled.finish.get("capacity-third")?.();
    await Promise.all([
      expectStatus("capacity-first", "completed"),
      expectStatus("capacity-second", "completed"),
      expectStatus("capacity-third", "completed"),
    ]);
  });

  it("orders queued jobs by descending priority and FIFO for ties", async () => {
    const controlled = installControlledCompositor();
    const twoUnitOutput = output({ resolution: "4k" });

    enqueueTestJob({ id: "priority-low", output: twoUnitOutput, priority: 0 });
    enqueueTestJob({ id: "priority-high-first", output: twoUnitOutput, priority: 10 });
    enqueueTestJob({ id: "priority-high-second", output: twoUnitOutput, priority: 10 });

    await vi.waitFor(() => expect(controlled.started).toEqual(["priority-high-first"]));
    expect(renderProgress(requiredSession("priority-high-second").job, 0).queue_position).toBe(1);
    expect(renderProgress(requiredSession("priority-low").job, 0).queue_position).toBe(2);
    expect(
      renderListActive("story-1").find((job) => job.id === "priority-high-second")?.queue_position,
    ).toBe(1);

    controlled.finish.get("priority-high-first")?.();
    await vi.waitFor(() =>
      expect(controlled.started).toEqual(["priority-high-first", "priority-high-second"]),
    );
    controlled.finish.get("priority-high-second")?.();
    await vi.waitFor(() =>
      expect(controlled.started).toEqual([
        "priority-high-first",
        "priority-high-second",
        "priority-low",
      ]),
    );
    controlled.finish.get("priority-low")?.();
    await Promise.all([
      expectStatus("priority-high-first", "completed"),
      expectStatus("priority-high-second", "completed"),
      expectStatus("priority-low", "completed"),
    ]);
  });

  it("enforces strict head-of-line scheduling without preemption", async () => {
    const controlled = installControlledCompositor();

    enqueueTestJob({ id: "hol-active" });
    await vi.waitFor(() => expect(controlled.started).toEqual(["hol-active"]));
    enqueueTestJob({ id: "hol-two-unit-head", output: output({ resolution: "4k" }), priority: 10 });
    enqueueTestJob({ id: "hol-one-unit-tail", priority: 0 });

    await vi.waitFor(() => expect(session("hol-two-unit-head")?.job.queue_position).toBe(1));
    expect(session("hol-one-unit-tail")?.job.queue_position).toBe(2);
    expect(controlled.started).toEqual(["hol-active"]);

    controlled.finish.get("hol-active")?.();
    await vi.waitFor(() => expect(controlled.started).toEqual(["hol-active", "hol-two-unit-head"]));
    expect(session("hol-one-unit-tail")?.job.status).toBe("queued");
    controlled.finish.get("hol-two-unit-head")?.();
    await vi.waitFor(() =>
      expect(controlled.started).toEqual(["hol-active", "hol-two-unit-head", "hol-one-unit-tail"]),
    );
    controlled.finish.get("hol-one-unit-tail")?.();
    await Promise.all([
      expectStatus("hol-active", "completed"),
      expectStatus("hol-two-unit-head", "completed"),
      expectStatus("hol-one-unit-tail", "completed"),
    ]);
  });

  it("cancels a queued job without probing audio or starting the compositor", async () => {
    const controlled = installControlledCompositor();
    const probeQueuedSource = vi.fn().mockResolvedValue(false);

    enqueueTestJob({ id: "queued-cancel-blocker", output: output({ resolution: "4k" }) });
    await vi.waitFor(() => expect(controlled.started).toEqual(["queued-cancel-blocker"]));
    const queuedReservation = enqueueTestJob({
      id: "queued-cancel-target",
      probeSourceAudio: probeQueuedSource,
    });
    await vi.waitFor(() => expect(session("queued-cancel-target")?.job.status).toBe("queued"));

    renderCancel("queued-cancel-target");

    expect(session("queued-cancel-target")?.job).toMatchObject({
      status: "cancelled",
      queue_position: null,
    });
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledWith(queuedReservation));
    expect(probeQueuedSource).not.toHaveBeenCalled();
    expect(controlled.started).toEqual(["queued-cancel-blocker"]);

    controlled.finish.get("queued-cancel-blocker")?.();
    await expectStatus("queued-cancel-blocker", "completed");
  });

  it("does not complete or commit until artifact verification succeeds", async () => {
    let finishVerification: (() => void) | undefined;
    let finishCommit: (() => void) | undefined;
    mocks.verify.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishVerification = resolve;
        }),
    );
    mocks.commit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    const outputReservation = reservation("verified-job");
    const twoUnitOutput = output({ resolution: "4k" });

    enqueueExportRenderJob({
      id: "verified-job",
      batchId: "batch-1",
      storyId: "story-1",
      output: twoUnitOutput,
      plan: planFor(twoUnitOutput),
      outputReservation,
    });
    enqueueTestJob({ id: "after-commit-job", output: twoUnitOutput });

    await expectStatus("verified-job", "verifying");
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(session("after-commit-job")?.job.started_at).toBeNull();
    finishVerification?.();
    await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledWith(outputReservation));
    expect(session("verified-job")?.job.status).toBe("verifying");
    expect(session("after-commit-job")?.job.started_at).toBeNull();
    mocks.verify.mockResolvedValue(undefined);
    mocks.commit.mockResolvedValue(undefined);
    finishCommit?.();
    await expectStatus("verified-job", "completed");
    await expectStatus("after-commit-job", "completed");
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
    const twoUnitOutput = output({ resolution: "4k" });

    for (const [id, outputReservation] of [
      ["failed-job", failedReservation],
      ["completed-job", completedReservation],
    ] as const) {
      enqueueExportRenderJob({
        id,
        batchId: "batch-2",
        storyId: "story-1",
        output: twoUnitOutput,
        plan: planFor(twoUnitOutput),
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

  it("runs measured MP4 loudness normalization before rendering frames", async () => {
    mocks.sourceHasAudio.mockResolvedValue(true);
    const analyzeLoudness = vi.fn(async (ffmpegArgs: string[]) => {
      expect(ffmpegArgs.join(" ")).toContain("loudnorm=I=-14:TP=-1:LRA=11");
      return JSON.stringify({
        input_i: "-20.25",
        input_tp: "-3.10",
        input_lra: "4.50",
        input_thresh: "-30.25",
        target_offset: "0.15",
      });
    });
    let finalFfmpegArgs: string[] = [];
    mocks.runComposited.mockImplementation(
      async (
        _activeSession: RenderSession,
        _plan: unknown,
        _onProgress: (frame: number) => void,
        ffmpegArgs: string[],
        onFramesComplete: () => void,
      ) => {
        finalFfmpegArgs = ffmpegArgs;
        onFramesComplete();
      },
    );

    enqueueTestJob({ id: "normalized-audio-job", analyzeLoudness });
    await expectStatus("normalized-audio-job", "completed");

    expect(analyzeLoudness).toHaveBeenCalledOnce();
    expect(finalFfmpegArgs.join(" ")).toContain("measured_I=-20.25");
    expect(finalFfmpegArgs.join(" ")).toContain("alimiter=limit=0.891251");
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ format: "mp4", expectAudio: true }),
    );
  });

  it("skips loudness passes for audio-free output", async () => {
    const analyzeLoudness = vi.fn();

    enqueueTestJob({ id: "audio-free-job", analyzeLoudness });
    await expectStatus("audio-free-job", "completed");

    expect(analyzeLoudness).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expectAudio: false }),
    );
  });

  it("fails and releases the reservation when loudness analysis fails", async () => {
    mocks.sourceHasAudio.mockResolvedValue(true);
    const outputReservation = enqueueTestJob({
      id: "loudness-failure-job",
      analyzeLoudness: vi.fn().mockRejectedValue(new Error("loudness analysis unavailable")),
    });

    await expectStatus("loudness-failure-job", "failed");
    expect(mocks.runComposited).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(outputReservation);
    expect(session("loudness-failure-job")?.job.error).toContain("loudness analysis unavailable");
  });

  it("exposes status and phase progress through the shared DTO", () => {
    const job = {
      id: "progress-job",
      status: "mixing",
      progress_pct: 90,
      phase_progress_pct: 50,
      fps: 30,
      queue_position: null,
    } as RenderJob;

    expect(renderProgress(job, 30)).toMatchObject({
      job_id: "progress-job",
      status: "mixing",
      pct: 90,
      phase_pct: 50,
      frame: 30,
      queue_position: null,
    });
  });
});

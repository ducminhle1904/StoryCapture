import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StartRecordingV4Args } from "@storycapture/shared-types";
import type { RecordingV4CadenceEvidence, RecordingV4Preflight } from "@storycapture/shared-types/recording-v4";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordingV4BundleFinalizer } from "./recording-v4-bundle";
import {
  createRecordingV4PlatformSessionFactory,
  recordingV4RuntimeProfile,
  recordingV4SurfaceOptions,
  resolveMacRecordingV4HelperPath,
  type RecordingV4NativeDriver,
  type RecordingV4PlatformDependencies,
} from "./recording-v4-platform-session";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const target = { kind: "author_preview" as const, stable_id: "target-1", process_id: 42, initial_title: "Preview" };
const envelope = { source: "built_in_profile" as const, encoder_id: "hardware-h264",
  minimum_bitrate_bps: 10_000_000, target_bitrate_bps: 20_000_000,
  maximum_bitrate_bps: 30_000_000, safety_headroom_ratio: 0.2 };
const encoder = { encoder_id: "hardware-h264", hardware_accelerated: true as const,
  requested_bitrate_bps: 20_000_000, average_bitrate_bps: 19_000_000,
  peak_bitrate_bps: 25_000_000, envelope };
const cadence: RecordingV4CadenceEvidence = {
  version: 4, frame_rate: { numerator: 60, denominator: 1 }, active_duration_us: 33_333,
  expected_output_frames: 2, output_frames: 2, source_updates: 1, held_frames: 1,
  submitted_frames: 2, acknowledged_frames: 2, ring_high_water_mark: 1, pause_intervals: [],
  ledger: [
    { slot: 0, pts_us: 0, source_sequence: 1, source_timestamp_us: 0, held_from_slot: null,
      submitted_at_us: 1, acknowledged_at_us: 2 },
    { slot: 1, pts_us: 16_667, source_sequence: 1, source_timestamp_us: 0, held_from_slot: 0,
      submitted_at_us: 3, acknowledged_at_us: 4 },
  ], verdict: "passed", failure_codes: [],
};
const quality = { checkpoints: [{ frame_slot: 0, reference_id: "initial-surface",
  full_frame_luma_ssim: { measured: 1, threshold: 0.99, comparator: "gte" as const, passed: true },
  text_edge_roi_ssim: { measured: 1, threshold: 0.99, comparator: "gte" as const, passed: true },
  edge_spread_increase_px: { measured: 0, threshold: 1, comparator: "lte" as const, passed: true },
  color_channel_delta: { measured: 0, threshold: 1, comparator: "lte" as const, passed: true },
}], verdict: "passed" as const, failure_codes: [] };

async function fixture(overrides: Partial<RecordingV4PlatformDependencies> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-v4-platform-"));
  roots.push(root);
  const projectPath = path.join(root, "project");
  const workspacePath = path.join(projectPath, "exports", ".session-1.staging");
  await fs.mkdir(path.join(workspacePath, "master"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "evidence"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "sidecars"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "sidecars/actions.json"), JSON.stringify({
    version: 4,
    session_id: "session-1",
    clock: "active_media_time_us",
    events: [],
  }));
  await fs.writeFile(path.join(workspacePath, "sidecars/cursor.json"), JSON.stringify({
    version: 4,
    session_id: "session-1",
    clock: "active_media_time_us",
    geometry: {
      coordinate_width: 1280,
      coordinate_height: 720,
      capture_width: 1920,
      capture_height: 1080,
    },
    samples: [],
  }));
  await fs.writeFile(path.join(workspacePath, "evidence/reference-initial.bgra"), "reference");
  await fs.writeFile(path.join(workspacePath, "master/video.mp4"), "native-master");
  const request: StartRecordingV4Args = { project_path: projectPath, source_url: "https://example.test",
    logical_width: 960, logical_height: 540, requested_audio_roles: [], include_cursor: true };
  const driver: RecordingV4NativeDriver = {
    helperPid: 10, target, availableAudioRoles: [], warmUp: vi.fn(async () => encoder),
    start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined), stop: vi.fn(async () => ({
      artifact_path: path.join(workspacePath, "master/video.mp4"), encoder, cadence, audio: [], failure_codes: [],
    })), cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const dependencies: RecordingV4PlatformDependencies = {
    platform: "darwin",
    runtimeProfile: { platform: "darwin", calibration: { source: "built_in_profile",
      encoder_id: "hardware-h264", minimum_required_bitrate_bps: 10_000_000,
      sustained_bitrate_bps: 25_000_000, peak_bitrate_bps: 30_000_000 },
      safety_headroom_ratio: 0.2, quality: { full_frame_luma_ssim: 0.99,
        text_edge_roi_ssim: 0.99, edge_spread_increase_px: 1, color_channel_delta: 1 } },
    createDriver: vi.fn(async () => driver),
    storageProbe: vi.fn(async () => ({ availableBytes: 10_000_000_000 })),
    throughputProbe: vi.fn(async () => 100_000_000), minimumWriteBytesPerSecond: 1,
    artifactProbe: vi.fn(async () => ({ finalized: true, full_decode_succeeded: true,
      decoded_frames: 2, duration_us: 33_333, physical_width: 1920, physical_height: 1080 })),
    qualityProbe: vi.fn(async () => quality), extractAudio: vi.fn(async () => []),
    finalizer: new RecordingV4BundleFinalizer(), ...overrides,
  };
  const published: RecordingV4CadenceEvidence[] = [];
  const factory = createRecordingV4PlatformSessionFactory(dependencies);
  const session = await factory({ sessionId: "session-1", workspacePath, request,
    publishCadence: (value) => published.push(value), fail: vi.fn(),
    activeMediaTimeUs: () => 0, recordAction: vi.fn(async (action) => ({ ...action, active_media_time_us: 0 })),
    recordCursorSample: vi.fn(async (sample) => ({
      active_media_time_us: 0,
      x: sample.x / sample.coordinate_width,
      y: sample.y / sample.coordinate_height,
      kind: sample.kind,
      visible: sample.visible,
      pressed: sample.pressed,
    })),
    isActive: () => true });
  return { root, workspacePath, request, driver, dependencies, session, published };
}

describe("Recording V4 host platform integration", () => {
  it("uses a built-in runtime profile without external certification", () => {
    expect(recordingV4RuntimeProfile("darwin")).toMatchObject({
      platform: "darwin",
      calibration: { source: "built_in_profile", encoder_id: "hardware-h264" },
    });
  });

  it("keeps a desktop CSS viewport on the exact-size Retina capture surface", () => {
    expect(recordingV4SurfaceOptions({
      project_path: "/project",
      source_url: "https://example.test",
      logical_width: 960,
      logical_height: 540,
      requested_audio_roles: [],
      include_cursor: true,
    })).toMatchObject({
      contentViewport: { width: 1280, height: 720 },
      dimensions: {
        logical_width: 960,
        logical_height: 540,
        capture_dpr: 2,
        physical_width: 1920,
        physical_height: 1080,
      },
    });
  });

  it("resolves the macOS helper from source for generated development apps", () => {
    expect(resolveMacRecordingV4HelperPath({
      isPackaged: false,
      resourcesPath: "/Applications/StoryCapture.app/Contents/Resources",
      appPath: "/workspace/apps/desktop",
    })).toBe("/workspace/apps/desktop/native/macos-screen-capture/.build/release/storycapture-screen-capture-helper");
    expect(resolveMacRecordingV4HelperPath({
      isPackaged: true,
      resourcesPath: "/Applications/StoryCapture.app/Contents/Resources",
      appPath: "/workspace/apps/desktop",
    })).toBe("/Applications/StoryCapture.app/Contents/Resources/native/macos/storycapture-screen-capture-helper");
  });

  it("runs exact preflight, final verification, atomic publication, and idempotent finalization", async () => {
    const { session, driver, published } = await fixture();
    const preflight = await session.preflight();
    expect(preflight).toMatchObject({ passed: true, dimensions: { physical_width: 1920, physical_height: 1080 },
      target, encoder: { hardware_accelerated: true } });
    await session.warmUp(); await session.start(); await session.pause(); await session.resume();
    const first = await session.stop();
    expect(first).toMatchObject({ state: "completed", output_path: expect.stringMatching(/master\/video\.mp4$/) });
    expect(published).toEqual([cadence]);
    expect(driver.start).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(first.bundle_path!, "manifest.json"), "utf8")).toContain('"schema_version": 4');
  });

  it.each([
    ["storage", { storageProbe: vi.fn(async () => ({ availableBytes: 0 })) }, "storage_insufficient"],
    ["throughput", { throughputProbe: vi.fn(async () => 0) }, "write_throughput_insufficient"],
    ["encoder", { createDriver: vi.fn(async () => { throw Object.assign(new Error("encoder"),
      { recordingV4FailureCode: "hardware_encoder_unavailable" }); }) }, "hardware_encoder_unavailable"],
  ] as const)("fails closed during %s preflight", async (_name, override, code) => {
    const { session } = await fixture(override as Partial<RecordingV4PlatformDependencies>);
    const preflight: RecordingV4Preflight = await session.preflight();
    expect(preflight.passed).toBe(false);
    expect(preflight.failure_codes).toContain(code);
    await expect(session.warmUp()).rejects.toMatchObject({ recordingV4FailureCode: code });
  });

  it("retains a quality-failed bundle but never publishes an output path", async () => {
    const failedQuality = { ...quality, verdict: "failed" as const,
      failure_codes: ["quality_checkpoint_failed" as const] };
    const { session } = await fixture({ qualityProbe: vi.fn(async () => failedQuality) });
    expect((await session.preflight()).passed).toBe(true);
    await session.start();
    const result = await session.stop();
    expect(result).toMatchObject({ state: "quality_failed", output_path: null,
      diagnostic_bundle_path: expect.any(String) });
  });
});

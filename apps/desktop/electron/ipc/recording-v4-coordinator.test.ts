import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StartRecordingV4Args } from "@storycapture/shared-types";
import {
  RECORDING_V4_CONTRACT_VERSION,
  RECORDING_V4_PROFILE,
  type RecordingV4Preflight,
  type RecordingV4Result,
} from "@storycapture/shared-types/recording-v4";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RecordingV4Coordinator,
  type RecordingV4PlatformSession,
  type RecordingV4PlatformSessionInput,
} from "./recording-v4-coordinator";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function request(projectPath: string): StartRecordingV4Args {
  return {
    project_path: projectPath,
    source_url: "https://example.test",
    logical_width: 960,
    logical_height: 540,
    requested_audio_roles: ["microphone", "system"],
    include_cursor: true,
  };
}

function passedPreflight(): RecordingV4Preflight {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    profile: RECORDING_V4_PROFILE,
    platform: "darwin",
    target: {
      kind: "author_preview",
      stable_id: "author-preview-main",
      process_id: 42,
      initial_title: "StoryCapture",
    },
    dimensions: { physical_width: 1920, physical_height: 1080 },
    permission_granted: true,
    storage_available_bytes: 2_000_000_000,
    storage_required_bytes: 1_000_000_000,
    measured_write_bytes_per_second: 100_000_000,
    encoder: {
      encoder_id: "videotoolbox-h264",
      hardware_accelerated: true,
      requested_bitrate_bps: 20_000_000,
      average_bitrate_bps: 20_000_000,
      peak_bitrate_bps: 24_000_000,
      envelope: {
        source: "live_calibration",
        encoder_id: "videotoolbox-h264",
        minimum_bitrate_bps: 16_000_000,
        target_bitrate_bps: 20_000_000,
        maximum_bitrate_bps: 25_000_000,
        safety_headroom_ratio: 0.2,
      },
    },
    requested_audio_roles: ["microphone", "system"],
    available_audio_roles: ["microphone", "system"],
    passed: true,
    failure_codes: [],
  };
}

function completedResult(sessionId: string): RecordingV4Result {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    profile: RECORDING_V4_PROFILE,
    session_id: sessionId,
    state: "completed",
    bundle_path: "/project/exports/take.sc-recording",
    output_path: "/project/exports/take.sc-recording/master/video.mp4",
    diagnostic_bundle_path: null,
    failure_codes: [],
  };
}

function webContents() {
  const messages: unknown[] = [];
  let destroyed = false;
  return {
    messages,
    setDestroyed(value: boolean) {
      destroyed = value;
    },
    value: {
      isDestroyed: () => destroyed,
      send: (_channel: string, payload: unknown) => messages.push(payload),
    } as unknown as WebContents,
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-recording-v4-"));
  roots.push(root);
  let monotonicUs = 1_000;
  let input: RecordingV4PlatformSessionInput | null = null;
  const requiredInput = () => {
    if (!input) throw new Error("Platform session input is not initialized.");
    return input;
  };
  const platform: RecordingV4PlatformSession = {
    helperPid: 777,
    preflight: vi.fn(async () => passedPreflight()),
    warmUp: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    stop: vi.fn(async () => completedResult(requiredInput().sessionId)),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const coordinator = new RecordingV4Coordinator({
    journalRoot: path.join(root, "journals"),
    platformSessionFactory: (value) => {
      input = value;
      return platform;
    },
    monotonicNowUs: () => monotonicUs,
    wallClockNow: () => new Date("2026-07-31T00:00:00.000Z"),
    sessionIdFactory: () => "session-1",
    heartbeatIntervalMs: 60_000,
  });
  return {
    root,
    coordinator,
    platform,
    platformInput: requiredInput,
    advance(us: number) {
      monotonicUs += us;
    },
  };
}

describe("Recording V4 coordinator", () => {
  it("survives renderer detach, maps actions to active media time, and publishes one terminal", async () => {
    const { root, coordinator, platform, advance } = await fixture();
    const session = await coordinator.create(request(root));
    const firstRenderer = webContents();
    coordinator.subscribe(session.id, firstRenderer.value, { id: 11 });

    await coordinator.command(session.id, "start");
    advance(20_000);
    const firstAction = await coordinator.recordAction(session.id, {
      step_id: "step-1",
      ordinal: 1,
      phase: "input",
    });
    await coordinator.command(session.id, "pause");
    advance(50_000);
    const pausedAction = await coordinator.recordAction(session.id, {
      step_id: "step-1",
      ordinal: 1,
      phase: "presented",
    });
    expect(pausedAction.active_media_time_us).toBe(firstAction.active_media_time_us);

    firstRenderer.setDestroyed(true);
    const reattachedRenderer = webContents();
    const snapshot = coordinator.subscribe(session.id, reattachedRenderer.value, { id: 12 });
    expect(snapshot).toMatchObject({ state: "paused", active_media_time_us: 20_000 });

    await coordinator.command(session.id, "resume");
    advance(30_000);
    const results = await Promise.all([
      coordinator.command(session.id, "stop"),
      coordinator.command(session.id, "stop"),
      coordinator.command(session.id, "cancel"),
    ]);

    expect(results.every((result) => result?.state === "completed")).toBe(true);
    expect(platform.stop).toHaveBeenCalledTimes(1);
    expect(platform.cancel).not.toHaveBeenCalled();
    expect(platform.dispose).toHaveBeenCalledTimes(1);
    const terminalEvents = reattachedRenderer.messages.filter(
      (message) => (message as { message?: { type?: string } }).message?.type === "terminal",
    );
    expect(terminalEvents).toHaveLength(1);

    const actions = JSON.parse(
      await fs.readFile(
        path.join(root, "exports", ".recording-v4-session-1.staging", "sidecars", "actions.json"),
        "utf8",
      ),
    ) as { events: Array<{ active_media_time_us: number }> };
    expect(actions.events.map((event) => event.active_media_time_us)).toEqual([20_000, 20_000]);
    const journal = await coordinator.journalStore.read(session.id);
    expect(journal).toMatchObject({ state: "completed", helper_pid: 777, revision: 9 });
  });

  it.each([
    "helper_crashed",
    "target_lost",
  ] as const)("converges a %s callback on one failed terminal result", async (failureCode) => {
    const { root, coordinator, platformInput } = await fixture();
    const session = await coordinator.create(request(root));
    const renderer = webContents();
    coordinator.subscribe(session.id, renderer.value, { id: 21 });
    await coordinator.command(session.id, "start");

    platformInput().fail(failureCode);
    await vi.waitFor(() => expect(coordinator.snapshot(session.id).state).toBe("failed"));
    const first = await coordinator.command(session.id, "stop");
    const second = await coordinator.command(session.id, "cancel");
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "failed", failure_codes: [failureCode] });
    expect(
      renderer.messages.filter(
        (message) => (message as { message?: { type?: string } }).message?.type === "terminal",
      ),
    ).toHaveLength(1);
  });

  it("rejects illegal transitions without changing the journal", async () => {
    const { root, coordinator } = await fixture();
    const session = await coordinator.create(request(root));
    await expect(coordinator.command(session.id, "pause")).rejects.toThrow(
      "Cannot pause Recording V4 from idle",
    );
    expect(coordinator.snapshot(session.id)).toMatchObject({ state: "idle", revision: 0 });
    expect(await coordinator.journalStore.read(session.id)).toMatchObject({
      state: "idle",
      revision: 0,
    });
  });

  it("makes repeated cancel idempotent before native startup", async () => {
    const { root, coordinator, platform } = await fixture();
    const session = await coordinator.create(request(root));
    const [first, second] = await Promise.all([
      coordinator.command(session.id, "cancel"),
      coordinator.command(session.id, "cancel"),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "cancelled" });
    expect(platform.cancel).not.toHaveBeenCalled();
    expect(platform.dispose).not.toHaveBeenCalled();
  });

  it("exposes a recovered failed snapshot for renderer reattach after restart", async () => {
    const { root, coordinator } = await fixture();
    await coordinator.journalStore.write({
      version: RECORDING_V4_CONTRACT_VERSION,
      session_id: "interrupted-session",
      project_path: root,
      workspace_path: path.join(root, "exports", ".interrupted.staging"),
      state: "capturing",
      revision: 4,
      helper_pid: 812,
      created_at: "2026-07-31T00:00:00.000Z",
      updated_at: "2026-07-31T00:01:00.000Z",
      terminal_result: null,
    });

    await coordinator.initialize();
    const renderer = webContents();
    const snapshot = coordinator.subscribe("interrupted-session", renderer.value, { id: 31 });

    expect(snapshot).toMatchObject({
      state: "failed",
      revision: 5,
      terminal_result: { failure_codes: ["journal_recovery_failed"] },
    });
    expect(renderer.messages.at(-1)).toEqual({ id: 31, end: true });
  });
});

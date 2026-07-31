import fs from "node:fs/promises";
import type { RecordingV4Preflight } from "@storycapture/shared-types/recording-v4";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const userDataPath = "/tmp/storycapture-recording-v4-ipc-test";

vi.mock("electron", () => ({
  app: { getPath: () => userDataPath },
}));

import { configureRecordingV4PlatformSessionFactory, recordingV4Handlers } from "./recording-v4";

const sender = {
  isDestroyed: () => false,
  send: vi.fn(),
};
const context = { event: { sender } } as never;
const request = {
  project_path: userDataPath,
  source_url: "https://example.test",
  logical_width: 960,
  logical_height: 540,
  requested_audio_roles: [],
  include_cursor: true,
};

const preflight: RecordingV4Preflight = {
  version: 4,
  profile: "verified_1080p60",
  platform: "darwin",
  target: {
    kind: "author_preview",
    stable_id: "preview",
    process_id: 12,
    initial_title: null,
  },
  dimensions: { physical_width: 1920, physical_height: 1080 },
  permission_granted: true,
  storage_available_bytes: 1,
  storage_required_bytes: 1,
  measured_write_bytes_per_second: 1,
  encoder: null,
  requested_audio_roles: [],
  available_audio_roles: [],
  passed: true,
  failure_codes: [],
};

configureRecordingV4PlatformSessionFactory((input) => ({
  helperPid: 1,
  preflight: async () => preflight,
  warmUp: async () => undefined,
  start: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  stop: async () => ({
    version: 4,
    profile: "verified_1080p60",
    session_id: input.sessionId,
    state: "failed",
    bundle_path: null,
    output_path: null,
    diagnostic_bundle_path: null,
    failure_codes: ["publication_failed"],
  }),
  cancel: async () => undefined,
  dispose: async () => undefined,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  sender.send.mockClear();
});

afterAll(async () => {
  await fs.rm(userDataPath, { recursive: true, force: true });
});

describe("Recording V4 IPC routing", () => {
  it("fails closed when the development route is disabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORYCAPTURE_ENABLE_RECORDING_V4", "0");

    await expect(
      recordingV4Handlers.recording_v4_start({ args: request }, context),
    ).rejects.toThrow("development-only");
  });

  it("fails closed in production even when the development flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORYCAPTURE_ENABLE_RECORDING_V4", "1");

    await expect(
      recordingV4Handlers.recording_v4_start({ args: request }, context),
    ).rejects.toThrow("development-only");
  });

  it("registers the initial renderer as a reattachable subscriber", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORYCAPTURE_ENABLE_RECORDING_V4", "1");
    const session = (await recordingV4Handlers.recording_v4_start(
      { args: request, onEvent: { id: 41 } },
      context,
    )) as { id: string };

    expect(sender.send).toHaveBeenCalledWith(
      "tauri-channel",
      expect.objectContaining({
        id: 41,
        message: expect.objectContaining({ type: "snapshot" }),
      }),
    );
    await expect(
      recordingV4Handlers.recording_v4_command({ session, command: "destroy" }),
    ).rejects.toThrow("command is invalid");
    await expect(recordingV4Handlers.recording_v4_snapshot({ session })).resolves.toMatchObject({
      state: "idle",
    });
    await recordingV4Handlers.recording_v4_command({ session, command: "cancel" });
  });
});

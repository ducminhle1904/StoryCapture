import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/storycapture-test" },
  BrowserWindow: vi.fn(),
  desktopCapturer: { getSources: vi.fn() },
  dialog: {},
  screen: {},
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater: {} },
}));

vi.mock("ffmpeg-static", () => ({ default: null }));

vi.mock("../recording-observability", () => ({
  recordEngineLog: vi.fn(async () => null),
}));

import { desktopCapturer } from "electron";
import { recordEngineLog } from "../recording-observability";
import { startRecording } from "./capture-preview";
import { stopRecording } from "./recording";
import { recordingSessions } from "./shared";

const tempDirs: string[] = [];

function captureSource() {
  return {
    id: "screen:1:0",
    name: "Display 1",
    display_id: "1",
    thumbnail: {
      isEmpty: () => false,
      toPNG: () => Buffer.from("png-frame"),
    },
  };
}

async function cleanupRecordingSessions(): Promise<void> {
  await Promise.all(
    [...recordingSessions.values()].map(async (session) => {
      clearInterval(session.heartbeat);
      if (session.captureTimer) clearInterval(session.captureTimer);
      session.pauseGate.cancel();
      await fs.rm(session.framesDir, { recursive: true, force: true });
    }),
  );
  recordingSessions.clear();
}

describe("legacy recording V2 logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupRecordingSessions();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("logs session start, first frame, and a successful terminal outcome in order", async () => {
    const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-logging-"));
    tempDirs.push(projectFolder);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([captureSource()] as never);
    const sender = { isDestroyed: () => false, send: vi.fn() };

    const started = await startRecording(
      {
        project_folder: projectFolder,
        target: { kind: "display", display_id: 1 },
        width: 1280,
        height: 720,
        fps: 30,
      },
      null,
      sender as never,
    );
    const session = recordingSessions.get(started.id);
    expect(session).toBeDefined();
    if (!session) return;
    await fs.writeFile(session.outputPath, Buffer.from("encoded-video"));
    session.streaming = true;
    session.sourceFramesReceived = 1;
    session.ffmpegDone = Promise.resolve();

    await expect(stopRecording(started.id)).resolves.toMatchObject({
      frame_count: 1,
      frames_written: 1,
    });

    const events = vi.mocked(recordEngineLog).mock.calls.map(([entry]) => entry.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "recording.session.created",
        "recording.backend.selected",
        "recording.preview.first_frame",
        "recording.backend.stopped",
        "recording.terminal",
      ]),
    );
    expect(events.indexOf("recording.session.created")).toBeLessThan(
      events.indexOf("recording.preview.first_frame"),
    );
    expect(events.indexOf("recording.preview.first_frame")).toBeLessThan(
      events.indexOf("recording.terminal"),
    );
    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recording.terminal",
        context: expect.objectContaining({
          session_id: started.id,
          verdict: "passed",
        }),
        details: expect.objectContaining({ outcome: "completed" }),
      }),
    );
  });

  it("logs target loss without exposing the target identity", async () => {
    const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-target-loss-"));
    tempDirs.push(projectFolder);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([]);

    const started = await startRecording(
      {
        project_folder: projectFolder,
        target: { kind: "display", display_id: 987654 },
        width: 1280,
        height: 720,
        fps: 30,
      },
      null,
      { isDestroyed: () => false, send: vi.fn() } as never,
    );

    expect(recordEngineLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "recording.backend.target_lost",
        context: {
          session_id: started.id,
          backend_id: "electron_desktop_capturer",
          phase: "capture",
          reason_code: "target_unavailable",
        },
        details: {
          target_kind: "display",
          frame_index: 1,
        },
      }),
    );
    const serializedCalls = JSON.stringify(vi.mocked(recordEngineLog).mock.calls);
    expect(serializedCalls).not.toContain("987654");
  });
});

import { startAuthorPreview, stopAuthorPreview } from "@/ipc/preview";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireRecordingPreview } from "./recording-preview";

vi.mock("@/ipc/preview", () => ({
  startAuthorPreview: vi.fn(),
  stopAuthorPreview: vi.fn(),
}));

vi.mock("@/lib/log", () => ({
  frontendLog: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const startAuthorPreviewMock = vi.mocked(startAuthorPreview);
const stopAuthorPreviewMock = vi.mocked(stopAuthorPreview);
const randomUUIDMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: randomUUIDMock });
  randomUUIDMock.mockReset();
  randomUUIDMock.mockReturnValue("uuid-1");
  startAuthorPreviewMock.mockReset();
  stopAuthorPreviewMock.mockReset();
  startAuthorPreviewMock.mockResolvedValue("author-recording-1");
  stopAuthorPreviewMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("recording preview lease", () => {
  it("starts a fresh non-replacing author preview for recording", async () => {
    const lease = await acquireRecordingPreview({
      appUrl: "https://app.example.test",
      viewport: { width: 1440, height: 900 },
      fps: 60,
      reason: "test",
    });

    expect(lease.streamId).toBe("author-recording-1");
    expect(startAuthorPreviewMock).toHaveBeenCalledWith({
      initialUrl: "https://app.example.test",
      viewportWidth: 1440,
      viewportHeight: 900,
      fps: 60,
      replaceExisting: false,
      partition: "recording-uuid-1",
      purpose: "recording",
    });
    const partition = startAuthorPreviewMock.mock.calls[0]?.[0].partition;
    expect(partition).toBe("recording-uuid-1");
    expect(partition?.startsWith("persist:")).toBe(false);
  });

  it("creates a new preview request for each recording", async () => {
    randomUUIDMock.mockReturnValueOnce("uuid-1");
    randomUUIDMock.mockReturnValueOnce("uuid-2");
    startAuthorPreviewMock.mockResolvedValueOnce("author-recording-1");
    startAuthorPreviewMock.mockResolvedValueOnce("author-recording-2");

    const first = await acquireRecordingPreview({
      appUrl: "https://app.example.test",
      viewport: { width: 1280, height: 720 },
      fps: 30,
      reason: "first",
    });
    const second = await acquireRecordingPreview({
      appUrl: "https://app.example.test",
      viewport: { width: 1280, height: 720 },
      fps: 60,
      reason: "second",
    });

    expect(first.streamId).toBe("author-recording-1");
    expect(second.streamId).toBe("author-recording-2");
    expect(startAuthorPreviewMock).toHaveBeenCalledTimes(2);
    expect(startAuthorPreviewMock.mock.calls[0]?.[0].partition).not.toBe(
      startAuthorPreviewMock.mock.calls[1]?.[0].partition,
    );
  });

  it("stops the recording preview exactly once when released", async () => {
    const lease = await acquireRecordingPreview({
      appUrl: "https://app.example.test",
      viewport: { width: 1280, height: 720 },
      fps: 60,
      reason: "cleanup",
    });

    lease.release();
    lease.release();
    await Promise.resolve();

    expect(stopAuthorPreviewMock).toHaveBeenCalledTimes(1);
    expect(stopAuthorPreviewMock).toHaveBeenCalledWith("author-recording-1");
  });

  it("times out and stops a late recording preview", async () => {
    vi.useFakeTimers();
    let resolveStart: (streamId: string) => void = () => {};
    startAuthorPreviewMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    const pending = acquireRecordingPreview({
      appUrl: "https://app.example.test",
      viewport: { width: 1280, height: 720 },
      fps: 60,
      reason: "timeout",
      timeoutMs: 10,
    });

    const rejection = expect(pending).rejects.toThrow(
      "Timed out waiting for recording browser preview",
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    resolveStart("author-late");
    await Promise.resolve();

    expect(stopAuthorPreviewMock).toHaveBeenCalledTimes(1);
    expect(stopAuthorPreviewMock).toHaveBeenCalledWith("author-late");
  });
});

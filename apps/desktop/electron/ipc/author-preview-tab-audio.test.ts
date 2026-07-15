import { describe, expect, it, vi } from "vitest";
import {
  AuthorPreviewTabGrantBroker,
  createRecordingAudioTrackRequest,
  validateRecordingAudioSelection,
} from "./audio-tracks";

describe("author-preview tab audio boundary", () => {
  it("denies recorded and stale frames while consuming the internal grant once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00Z"));
    const broker = new AuthorPreviewTabGrantBroker();
    const internalFrame = { kind: "internal" } as never;
    const recordedPageFrame = { kind: "recorded-page" } as never;
    const authorPreviewFrame = { kind: "author-preview" } as never;
    broker.arm({
      sessionId: "session-1",
      trackId: "tab-1",
      captureToken: "opaque-token",
      requester: internalFrame,
      source: authorPreviewFrame,
      ttlMs: 100,
    });
    expect(broker.consume(recordedPageFrame)).toBeNull();
    expect(broker.consume(internalFrame)?.source).toBe(authorPreviewFrame);
    expect(broker.consume(internalFrame)).toBeNull();

    broker.arm({
      sessionId: "session-2",
      trackId: "tab-2",
      captureToken: "opaque-token-2",
      requester: internalFrame,
      source: authorPreviewFrame,
      ttlMs: 100,
    });
    vi.advanceTimersByTime(101);
    expect(broker.consume(internalFrame)).toBeNull();
    vi.useRealTimers();
  });

  it("binds tab selection to author_preview only", () => {
    const tab = createRecordingAudioTrackRequest({
      role: "tab",
      requirement: "required",
      source_id: "preview-1",
    });
    expect(() => validateRecordingAudioSelection("author_preview", [tab])).not.toThrow();
    expect(() => validateRecordingAudioSelection("display", [tab])).toThrow(
      "tab audio requires author_preview",
    );
  });
});

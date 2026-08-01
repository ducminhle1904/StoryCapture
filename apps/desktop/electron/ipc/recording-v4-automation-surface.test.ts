import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recordingV4AutomationSurface,
  registerRecordingV4AutomationSurface,
  unregisterRecordingV4AutomationSurface,
} from "./recording-v4-automation-surface";

const sessionId = "recording-v4-session";

afterEach(() => unregisterRecordingV4AutomationSurface(sessionId));

describe("Recording V4 automation surface registry", () => {
  it("exposes the native capture surface only for its owning session", () => {
    const surface = {
      contents: {} as WebContents,
      inputCoordinateScale: 2,
      cursorCoordinateSize: { width: 1280, height: 720 },
      currentMediaTimeMs: () => 42,
      recordAction: vi.fn(async () => undefined),
      recordCursorSample: vi.fn(async () => undefined),
      isActive: () => true,
    };
    registerRecordingV4AutomationSurface(sessionId, surface);

    expect(recordingV4AutomationSurface(sessionId)).toBe(surface);
    expect(recordingV4AutomationSurface("other-session")).toBeNull();
    expect(() => registerRecordingV4AutomationSurface(sessionId, surface)).toThrow(
      /already exists/,
    );

    unregisterRecordingV4AutomationSurface(sessionId);
    expect(recordingV4AutomationSurface(sessionId)).toBeNull();
  });
});

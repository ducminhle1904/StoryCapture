import { afterEach, describe, expect, it } from "vitest";

import { useRecorderStore } from "@/state/recorder";

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

afterEach(() => useRecorderStore.getState().reset());

describe("recorder reset scopes", () => {
  it("resetTake clears take data while preserving target discovery", () => {
    useRecorderStore.setState({
      status: "completed",
      sessionId: "take-1",
      error: "old error",
      outputPath: "/tmp/take-1.mp4",
      elapsedMs: 1234,
      captureTarget: target,
      availableTargets: targets,
      audioDeviceId: "default",
      includeCursor: true,
      chromeHiding: false,
    });

    useRecorderStore.getState().resetTake();

    expect(useRecorderStore.getState()).toMatchObject({
      status: "idle",
      sessionId: null,
      error: null,
      outputPath: null,
      elapsedMs: 0,
      captureTarget: target,
      availableTargets: targets,
      audioDeviceId: null,
      includeCursor: false,
      chromeHiding: true,
    });
  });

  it("reset remains a full store reset", () => {
    useRecorderStore.setState({ captureTarget: target, availableTargets: targets });

    useRecorderStore.getState().reset();

    expect(useRecorderStore.getState().captureTarget).toBeNull();
    expect(useRecorderStore.getState().availableTargets).toBeNull();
  });
});

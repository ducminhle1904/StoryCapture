import type { RecordingPreflightV3Dto } from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";
import {
  type RecordingV3CoordinatorSession,
  RecordingV3HostSessionRegistry,
} from "./recording-v3-session-registry";

const preflight: RecordingPreflightV3Dto = {
  version: 3,
  intent: "strict",
  backend_id: "backend",
  backend_version: "3.0.0",
  addon_protocol_version: 3,
  platform: "darwin",
  arch: "arm64",
  hardware_model: "Mac17,2",
  hardware_chip: "Apple M5",
  os_build: "25F84",
  manifest_id: null,
  matched_profile: null,
  source_rate: {
    measured_fps: null,
    source_presentations: 0,
    sequence_gaps: 0,
    stale_reuses: 0,
    probe_duration_ms: 0,
  },
  storage: {
    estimated_bytes_per_second: 0,
    required_bytes_for_ten_minutes: 0,
    available_bytes: 0,
    reserve_bytes: 0,
  },
  native_probe_passed: false,
  permissions_granted: true,
  strict_eligible: false,
  failure_codes: ["manifest_missing"],
};

describe("RecordingV3HostSessionRegistry", () => {
  it("retains terminal state across query until explicit acknowledgement", () => {
    let tick = 0;
    const registry = new RecordingV3HostSessionRegistry<RecordingV3CoordinatorSession>(() =>
      new Date(++tick).toISOString(),
    );
    registry.register({ id: "take-1", projectFolder: "/project", startedAt: 100, preflight });
    registry.updateLifecycle("take-1", "paused");
    registry.fail("take-1", ["target_lost"], "target vanished");

    expect(registry.query("/project")[0]).toMatchObject({
      id: "take-1",
      lifecycle: "terminal_unacknowledged",
      failure_codes: ["target_lost"],
    });
    expect(registry.acknowledge("take-1")).toBe(true);
    expect(registry.query("/project")).toEqual([]);
    expect(registry.acknowledge("take-1")).toBe(false);
  });

  it("does not acknowledge active or paused sessions", () => {
    const registry = new RecordingV3HostSessionRegistry<RecordingV3CoordinatorSession>();
    registry.register({ id: "take-1", projectFolder: "/project", startedAt: 100, preflight });
    expect(registry.acknowledge("take-1")).toBe(false);
    registry.updateLifecycle("take-1", "paused");
    expect(registry.acknowledge("take-1")).toBe(false);
  });
});

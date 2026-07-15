import { describe, expect, it, vi } from "vitest";

import {
  fingerprintRecordingPreflightRequest,
  RECORDING_PREFLIGHT_CACHE_TTL_MS,
  RECORDING_PREFLIGHT_CHECK_IDS,
  RECORDING_PREFLIGHT_DISK_BLOCK_BYTES,
  RECORDING_PREFLIGHT_DISK_WARN_BYTES,
  type RecordingPreflightCheckId,
  type RecordingPreflightDependencies,
  type RecordingPreflightReportV1,
  type RecordingPreflightRequestV1,
  RecordingPreflightValidator,
  resolveExactPreflightTarget,
} from "./recording-preflight";

function request(
  overrides: Partial<RecordingPreflightRequestV1> = {},
): RecordingPreflightRequestV1 {
  return {
    version: 1,
    target: { kind: "author_preview", stream_id: "author-1" },
    output_directory: "/tmp/storycapture-exports",
    width: 1920,
    height: 1080,
    fps: 30,
    audio_roles: [],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RecordingPreflightDependencies> = {},
): RecordingPreflightDependencies {
  return {
    now: vi.fn(() => Date.UTC(2026, 6, 14, 0, 0, 0)),
    getScreenPermission: vi.fn(async () => "granted" as const),
    listCaptureSources: vi.fn(async () => []),
    inspectAuthorPreview: vi.fn(async () => ({ live: true, thumbnail_available: true })),
    inspectEncoder: vi.fn(async () => ({
      path: "/app/ffmpeg",
      exists: true,
      is_file: true,
      executable: true,
    })),
    smokeEncoder: vi.fn(async () => true),
    inspectOutputDirectory: vi.fn(async () => ({
      exists: true,
      is_directory: true,
      writable: true,
      free_bytes: RECORDING_PREFLIGHT_DISK_WARN_BYTES,
    })),
    listAudioInputIds: vi.fn(async () => ["mic-1"]),
    getAudioRoleCapability: vi.fn(async () => ({
      state: "available" as const,
      reason: "available",
    })),
    getProfileCapability: vi.fn(async () => ({ supported: true, reason: "profile_supported" })),
    getStartupGate: vi.fn(async () => ({ active_session: false, recovery_holds_gate: false })),
    ...overrides,
  };
}

function reportCheck(report: RecordingPreflightReportV1, id: RecordingPreflightCheckId) {
  const found = report.checks.find((item) => item.id === id);
  if (!found) throw new Error(`missing preflight check ${id}`);
  return found;
}

describe("RecordingPreflightValidator", () => {
  it("returns all seven checks in stable order without allocating or mutating media", async () => {
    const deps = dependencies();
    const report = await new RecordingPreflightValidator(deps).run(request());

    expect(report.checks.map((item) => item.id)).toEqual(RECORDING_PREFLIGHT_CHECK_IDS);
    expect(report.verdict).toBe("pass");
    expect(report.capabilities).toEqual({
      target: {
        kind: "author_preview",
        electron_capture: "available",
        reason: "target_live",
      },
      capture_profile: {
        width: 1920,
        height: 1080,
        fps: 30,
        state: "available",
        reason: "profile_supported",
      },
      encoder: { state: "available", reason: "encoder_available" },
      audio: [],
    });
    expect(deps.getScreenPermission).not.toHaveBeenCalled();
    expect(deps.listCaptureSources).not.toHaveBeenCalled();
    expect(deps.listAudioInputIds).not.toHaveBeenCalled();
    expect(deps.getAudioRoleCapability).not.toHaveBeenCalled();
    expect(deps.inspectOutputDirectory).toHaveBeenCalledWith("/tmp/storycapture-exports");
  });

  it("does not require screen permission for author preview but blocks external targets without it", async () => {
    const authorDeps = dependencies({ getScreenPermission: vi.fn(async () => "denied" as const) });
    const author = await new RecordingPreflightValidator(authorDeps).run(request());
    expect(reportCheck(author, "permission")).toMatchObject({
      status: "pass",
      reason: "permission_not_required",
    });
    expect(authorDeps.getScreenPermission).not.toHaveBeenCalled();

    const externalDeps = dependencies({
      getScreenPermission: vi.fn(async () => "restricted" as const),
      listCaptureSources: vi.fn(async () => [
        {
          id: "screen:7:0",
          name: "Display 7",
          display_id: "7",
          thumbnail_available: true,
        },
      ]),
    });
    const external = await new RecordingPreflightValidator(externalDeps).run(
      request({ target: { kind: "display", display_id: 7 } }),
    );
    expect(reportCheck(external, "permission")).toMatchObject({
      status: "block",
      reason: "permission_restricted",
    });
  });

  it("matches the exact display, window, or PID target and never falls back to the first source", async () => {
    const sources = [
      {
        id: "window:10:0",
        name: "First window",
        display_id: null,
        pid: 100,
        thumbnail_available: true,
      },
      {
        id: "window:20:0",
        name: "Wanted window",
        window_id: 20,
        pid: 200,
        thumbnail_available: true,
      },
    ];
    expect(resolveExactPreflightTarget({ kind: "window", window_id: 20 }, sources)?.id).toBe(
      "window:20:0",
    );
    expect(resolveExactPreflightTarget({ kind: "window", window_id: 99 }, sources)).toBeNull();
    expect(
      resolveExactPreflightTarget(
        { kind: "window_by_pid", pid: 200, title_hint: "Wanted" },
        sources,
      )?.id,
    ).toBe("window:20:0");
    expect(resolveExactPreflightTarget({ kind: "display", display_id: 7 }, sources)).toBeNull();

    const deps = dependencies({ listCaptureSources: vi.fn(async () => sources) });
    const report = await new RecordingPreflightValidator(deps).run(
      request({ target: { kind: "window", window_id: 99 } }),
    );
    expect(reportCheck(report, "target_live")).toMatchObject({
      status: "block",
      reason: "target_missing",
    });
    expect(report.capabilities.target.electron_capture).toBe("unavailable");
  });

  it("blocks an exact target that cannot produce a liveness thumbnail", async () => {
    const deps = dependencies({
      listCaptureSources: vi.fn(async () => [
        {
          id: "screen:1:0",
          name: "Display",
          display_id: "1",
          thumbnail_available: false,
        },
      ]),
    });
    const report = await new RecordingPreflightValidator(deps).run(
      request({ target: { kind: "display", display_id: 1 } }),
    );
    expect(reportCheck(report, "target_live")).toMatchObject({
      status: "block",
      reason: "target_thumbnail_unavailable",
    });
  });

  it("uses a canonical SHA-256 fingerprint and only reuses the unchanged configuration for ten seconds", async () => {
    let now = Date.UTC(2026, 6, 14, 0, 0, 0);
    const deps = dependencies({ now: vi.fn(() => now) });
    const validator = new RecordingPreflightValidator(deps);
    const firstRequest = request({
      target: { kind: "display", display_id: 7 },
      audio_roles: [
        { role: "system", policy: "optional" },
        { role: "microphone", policy: "required", device_id: "mic-1" },
      ],
    });
    deps.listCaptureSources = vi.fn(async () => [
      {
        id: "screen:7:0",
        name: "Display 7",
        display_id: "7",
        thumbnail_available: true,
      },
    ]);
    const equivalent = request({
      target: { kind: "display", display_id: "7" },
      audio_roles: [...firstRequest.audio_roles].reverse(),
    });

    expect(fingerprintRecordingPreflightRequest(firstRequest)).toBe(
      fingerprintRecordingPreflightRequest(equivalent),
    );
    expect(fingerprintRecordingPreflightRequest(firstRequest)).toMatch(/^[a-f0-9]{64}$/);

    const first = await validator.run(firstRequest);
    const encoderCalls = vi.mocked(deps.inspectEncoder).mock.calls.length;
    now += RECORDING_PREFLIGHT_CACHE_TTL_MS;
    const cached = await validator.run(equivalent);
    expect(cached).toBe(first);
    expect(deps.inspectEncoder).toHaveBeenCalledTimes(encoderCalls);

    now += 1;
    const refreshed = await validator.run(equivalent);
    expect(refreshed).not.toBe(first);
    expect(deps.inspectEncoder).toHaveBeenCalledTimes(encoderCalls + 1);

    const changed = await validator.run({ ...equivalent, fps: 60 });
    expect(changed.fingerprint).not.toBe(refreshed.fingerprint);
    expect(deps.inspectEncoder).toHaveBeenCalledTimes(encoderCalls + 2);
  });

  it.each([
    [RECORDING_PREFLIGHT_DISK_BLOCK_BYTES - 1, "block", "disk_space_critical"],
    [RECORDING_PREFLIGHT_DISK_BLOCK_BYTES, "warn", "disk_space_low"],
    [RECORDING_PREFLIGHT_DISK_WARN_BYTES - 1, "warn", "disk_space_low"],
    [RECORDING_PREFLIGHT_DISK_WARN_BYTES, "pass", "disk_space_sufficient"],
  ] as const)("classifies %s free bytes as %s", async (freeBytes, status, reason) => {
    const deps = dependencies({
      inspectOutputDirectory: vi.fn(async () => ({
        exists: true,
        is_directory: true,
        writable: true,
        free_bytes: freeBytes,
      })),
    });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "disk_space")).toMatchObject({ status, reason });
  });

  it("warns on unknown disk space in warn mode and blocks it in block mode", async () => {
    const inspectOutputDirectory = vi.fn(async () => ({
      exists: true,
      is_directory: true,
      writable: true,
      free_bytes: null,
    }));
    const warning = await new RecordingPreflightValidator(
      dependencies({ inspectOutputDirectory }),
      { mode: "warn" },
    ).run(request());
    const blocking = await new RecordingPreflightValidator(
      dependencies({ inspectOutputDirectory }),
      { mode: "block" },
    ).run(request());
    expect(reportCheck(warning, "disk_space")).toMatchObject({
      status: "warn",
      reason: "disk_space_unknown",
    });
    expect(reportCheck(blocking, "disk_space")).toMatchObject({
      status: "block",
      reason: "disk_space_unknown",
    });
  });

  it.each([
    [{ exists: false, is_directory: false, writable: false }, "output_missing"],
    [{ exists: true, is_directory: false, writable: false }, "output_not_directory"],
    [{ exists: true, is_directory: true, writable: false }, "output_not_writable"],
  ] as const)("rejects invalid output metadata with %s", async (state, reason) => {
    const deps = dependencies({
      inspectOutputDirectory: vi.fn(async () => ({
        ...state,
        free_bytes: RECORDING_PREFLIGHT_DISK_WARN_BYTES,
      })),
    });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "output_valid")).toMatchObject({ status: "block", reason });
  });

  it.each([
    [{ path: null, exists: false, is_file: false, executable: false }, "encoder_missing"],
    [{ path: "/app/ffmpeg", exists: true, is_file: false, executable: true }, "encoder_not_file"],
    [
      { path: "/app/ffmpeg", exists: true, is_file: true, executable: false },
      "encoder_not_executable",
    ],
  ] as const)("rejects unusable encoder metadata with %s", async (inspection, reason) => {
    const deps = dependencies({ inspectEncoder: vi.fn(async () => inspection) });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "encoder_available")).toMatchObject({
      status: "block",
      reason,
    });
    expect(deps.smokeEncoder).not.toHaveBeenCalled();
  });

  it("blocks a failed encoder smoke without exposing the binary path", async () => {
    const deps = dependencies({ smokeEncoder: vi.fn(async () => false) });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "encoder_available")).toMatchObject({
      status: "block",
      reason: "encoder_smoke_failed",
    });
    expect(JSON.stringify(report)).not.toContain("/app/ffmpeg");
  });

  it("bounds and aborts an encoder smoke that never settles", async () => {
    const deps = dependencies({
      smokeEncoder: vi.fn((_path, _signal) => {
        return new Promise<boolean>(() => undefined);
      }),
    });
    const report = await new RecordingPreflightValidator(deps, {
      encoderSmokeTimeoutMs: 5,
    }).run(request());
    expect(reportCheck(report, "encoder_available")).toMatchObject({
      status: "block",
      reason: "encoder_smoke_timeout",
    });
    expect(vi.mocked(deps.smokeEncoder).mock.calls[0]?.[1].aborted).toBe(true);
  });

  it("turns an encoder inspection exception into a typed blocking check", async () => {
    const deps = dependencies({
      inspectEncoder: vi.fn(async () => {
        throw new Error("sensitive host failure");
      }),
    });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "encoder_available")).toMatchObject({
      status: "block",
      reason: "check_unavailable",
    });
    expect(JSON.stringify(report)).not.toContain("sensitive host failure");
  });

  it("reports no requested audio without enumerating devices", async () => {
    const deps = dependencies();
    const report = await new RecordingPreflightValidator(deps).run(request({ audio_roles: [] }));
    expect(reportCheck(report, "audio_device")).toMatchObject({
      status: "pass",
      reason: "audio_not_requested",
    });
    expect(report.capabilities.audio).toEqual([]);
    expect(deps.listAudioInputIds).not.toHaveBeenCalled();
  });

  it("blocks a missing required microphone and warns for an unavailable optional role", async () => {
    const missingMic = await new RecordingPreflightValidator(
      dependencies({ listAudioInputIds: vi.fn(async () => []) }),
    ).run(
      request({
        audio_roles: [{ role: "microphone", policy: "required", device_id: "missing" }],
      }),
    );
    expect(reportCheck(missingMic, "audio_device")).toMatchObject({
      status: "block",
      reason: "required_audio_unavailable",
    });
    expect(missingMic.capabilities.audio).toEqual([
      {
        role: "microphone",
        required: true,
        state: "unavailable",
        reason: "microphone_device_not_found",
      },
    ]);

    const optional = await new RecordingPreflightValidator(
      dependencies({
        getAudioRoleCapability: vi.fn(async () => ({
          state: "unavailable" as const,
          reason: "system_audio_unavailable",
        })),
      }),
    ).run(request({ audio_roles: [{ role: "system", policy: "optional" }] }));
    expect(reportCheck(optional, "audio_device")).toMatchObject({
      status: "warn",
      reason: "optional_audio_unavailable",
    });
    expect(optional.capabilities.audio[0]).toMatchObject({
      role: "system",
      required: false,
      state: "unavailable",
    });
  });

  it("reports audio enumeration failures as an unavailable check", async () => {
    const report = await new RecordingPreflightValidator(
      dependencies({
        listAudioInputIds: vi.fn(async () => {
          throw new Error("device labels must not escape");
        }),
      }),
    ).run(
      request({
        audio_roles: [{ role: "microphone", policy: "required", device_id: "mic-1" }],
      }),
    );
    expect(reportCheck(report, "audio_device")).toMatchObject({
      status: "block",
      reason: "required_audio_unavailable",
    });
    expect(report.capabilities.audio[0]).toMatchObject({ reason: "check_unavailable" });
    expect(JSON.stringify(report)).not.toContain("device labels must not escape");
  });

  it("reports unsupported future audio roles instead of omitting or substituting them", async () => {
    const deps = dependencies();
    const report = await new RecordingPreflightValidator(deps).run(
      request({ audio_roles: [{ role: "future-role", policy: "required" }] }),
    );
    expect(reportCheck(report, "audio_device")).toMatchObject({
      status: "block",
      reason: "required_audio_unavailable",
    });
    expect(report.capabilities.audio).toEqual([
      {
        role: "future-role",
        required: true,
        state: "unsupported",
        reason: "unsupported_audio_role",
      },
    ]);
    expect(deps.getAudioRoleCapability).not.toHaveBeenCalled();
  });

  it.each([
    [{ active_session: true, recovery_holds_gate: false }, "active_session"],
    [{ active_session: false, recovery_holds_gate: true }, "recovery_in_progress"],
  ] as const)("blocks startup gate state %s", async (gate, reason) => {
    const deps = dependencies({ getStartupGate: vi.fn(async () => gate) });
    const report = await new RecordingPreflightValidator(deps).run(request());
    expect(reportCheck(report, "no_active_session")).toMatchObject({ status: "block", reason });
  });

  it("reports an unsupported capture profile in capabilities and blocks encoder readiness", async () => {
    const deps = dependencies({
      getProfileCapability: vi.fn(async () => ({ supported: false, reason: "fps_unsupported" })),
    });
    const report = await new RecordingPreflightValidator(deps).run(request({ fps: 240 }));
    expect(reportCheck(report, "encoder_available")).toMatchObject({
      status: "block",
      reason: "capture_profile_unsupported",
    });
    expect(report.capabilities.capture_profile).toMatchObject({
      fps: 240,
      state: "unsupported",
      reason: "fps_unsupported",
    });
    expect(report.capabilities.encoder.state).toBe("available");
  });
});

import type {
  CaptureBackendV2Capabilities,
  CaptureBackendV2Frame,
  CaptureBackendV2SessionStart,
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
} from "@storycapture/shared-types/recording-v2";

export type CaptureBackendV2Lifecycle =
  | "idle"
  | "probed"
  | "recording"
  | "paused"
  | "stopped"
  | "failed";

export class CaptureBackendV2Error extends Error {
  constructor(
    readonly code: RecordingQualityFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureBackendV2Error";
  }
}

function addFailure(
  failures: RecordingQualityFailureCode[],
  code: RecordingQualityFailureCode,
): void {
  if (!failures.includes(code)) failures.push(code);
}

function isExact60Fps(request: RecordingPreflightV2Request): boolean {
  return request.requested_fps.numerator === 60 && request.requested_fps.denominator === 1;
}

function dimensionsArePhysical(request: RecordingPreflightV2Request): boolean {
  const dimensions = request.dimensions;
  return (
    Number.isInteger(dimensions.logical_width) &&
    Number.isInteger(dimensions.logical_height) &&
    dimensions.logical_width > 0 &&
    dimensions.logical_height > 0 &&
    Number.isFinite(dimensions.capture_dpr) &&
    dimensions.capture_dpr > 0 &&
    Math.round(dimensions.logical_width * dimensions.capture_dpr) === dimensions.physical_width &&
    Math.round(dimensions.logical_height * dimensions.capture_dpr) === dimensions.physical_height &&
    dimensions.physical_width >= dimensions.requested_output_width &&
    dimensions.physical_height >= dimensions.requested_output_height
  );
}

export function validateCaptureBackendV2Request(
  capabilities: CaptureBackendV2Capabilities,
  request: RecordingPreflightV2Request,
): RecordingQualityFailureCode[] {
  const failures: RecordingQualityFailureCode[] = [];
  if (request.version !== capabilities.version) addFailure(failures, "contract_mismatch");
  if (!capabilities.target_classes.includes(request.target_class)) {
    addFailure(failures, "backend_capability_mismatch");
  }
  if (!dimensionsArePhysical(request)) addFailure(failures, "contract_mismatch");

  if (request.delivery_policy === "strict") {
    if (!isExact60Fps(request)) addFailure(failures, "contract_mismatch");
    if (
      request.dimensions.requested_output_width !== 1_920 ||
      request.dimensions.requested_output_height !== 1_080
    ) {
      addFailure(failures, "contract_mismatch");
    }
    if (
      !capabilities.supports_native_timestamps ||
      !capabilities.supports_source_sequences ||
      !capabilities.supports_physical_pixels ||
      !capabilities.supports_cursor_policy ||
      !capabilities.supports_pause_resume
    ) {
      addFailure(failures, "backend_capability_mismatch");
    }
  }
  return failures;
}

export function validateCaptureBackendV2Preflight(
  capabilities: CaptureBackendV2Capabilities,
  request: RecordingPreflightV2Request,
  preflight: RecordingPreflightV2Dto,
): RecordingQualityFailureCode[] {
  const failures = [
    ...validateCaptureBackendV2Request(capabilities, request),
    ...preflight.failure_codes,
  ];
  if (
    preflight.version !== capabilities.version ||
    preflight.backend_id !== capabilities.backend_id ||
    preflight.backend_version !== capabilities.backend_version
  ) {
    addFailure(failures, "contract_mismatch");
  }
  if (!preflight.permissions_granted) addFailure(failures, "permission_denied");
  if (request.delivery_policy === "strict") {
    if (
      preflight.source_rate.measured_fps?.numerator !== 60 ||
      preflight.source_rate.measured_fps.denominator !== 1 ||
      preflight.source_rate.sequence_gaps !== 0 ||
      preflight.source_rate.stale_reuses !== 0
    ) {
      addFailure(failures, "source_rate_mismatch");
    }
    if (preflight.encode_throughput_ratio < 1.5) {
      addFailure(failures, "backend_capability_mismatch");
    }
    if (
      preflight.storage.available_bytes <
      preflight.storage.required_bytes_for_ten_minutes + preflight.storage.reserve_bytes
    ) {
      addFailure(failures, "storage_reserve_exhausted");
    }
    if (!preflight.certification_match || preflight.certification?.stage !== "certified") {
      addFailure(failures, "uncertified_tier");
    }
  }
  return [...new Set(failures)];
}

function sameRequest(
  left: RecordingPreflightV2Request,
  right: RecordingPreflightV2Request,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Enforces the shared probe/session/delivery state machine for every V2 backend. */
export class CaptureBackendV2Guard {
  private lifecycleValue: CaptureBackendV2Lifecycle = "idle";
  private preflightRequest: RecordingPreflightV2Request | null = null;
  private preflightResult: RecordingPreflightV2Dto | null = null;
  private sessionIdValue: string | null = null;
  private previousFrame: CaptureBackendV2Frame | null = null;
  private stickyFailureValue: CaptureBackendV2Error | null = null;

  constructor(readonly capabilities: CaptureBackendV2Capabilities) {}

  get lifecycle(): CaptureBackendV2Lifecycle {
    return this.lifecycleValue;
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get stickyFailure(): CaptureBackendV2Error | null {
    return this.stickyFailureValue;
  }

  get request(): RecordingPreflightV2Request | null {
    return this.preflightRequest;
  }

  acceptProbe(
    request: RecordingPreflightV2Request,
    result: RecordingPreflightV2Dto,
  ): RecordingPreflightV2Dto {
    if (this.lifecycleValue !== "idle" && this.lifecycleValue !== "probed") {
      throw new CaptureBackendV2Error(
        "contract_mismatch",
        "backend cannot probe an active session",
      );
    }
    const failureCodes = validateCaptureBackendV2Preflight(this.capabilities, request, result);
    const accepted = {
      ...result,
      failure_codes: failureCodes,
      strict_eligible: request.delivery_policy === "strict" && failureCodes.length === 0,
    };
    this.preflightRequest = request;
    this.preflightResult = accepted;
    this.lifecycleValue = "probed";
    return accepted;
  }

  begin(start: CaptureBackendV2SessionStart): void {
    if (this.lifecycleValue !== "probed" || !this.preflightRequest || !this.preflightResult) {
      throw new CaptureBackendV2Error("preflight_failed", "backend session requires preflight");
    }
    if (!start.session_id || !sameRequest(start.request, this.preflightRequest)) {
      throw new CaptureBackendV2Error(
        "contract_mismatch",
        "session request differs from preflight",
      );
    }
    if (start.request.delivery_policy === "strict" && !this.preflightResult.strict_eligible) {
      throw new CaptureBackendV2Error(
        this.preflightResult.failure_codes[0] ?? "preflight_failed",
        "strict backend preflight did not pass",
      );
    }
    this.sessionIdValue = start.session_id;
    this.lifecycleValue = "recording";
  }

  acceptFrame(frame: CaptureBackendV2Frame): void {
    if (this.stickyFailureValue) throw this.stickyFailureValue;
    if (this.lifecycleValue !== "recording") {
      throw this.fail("contract_mismatch", "frame arrived while backend was not recording");
    }
    const request = this.preflightRequest;
    if (
      !request ||
      frame.pixel_format !== "bgra" ||
      frame.width !== request.dimensions.physical_width ||
      frame.height !== request.dimensions.physical_height ||
      frame.stride !== frame.width * 4 ||
      !Number.isSafeInteger(frame.source_sequence) ||
      frame.source_sequence < 1 ||
      !Number.isSafeInteger(frame.native_pts_us) ||
      frame.native_pts_us < 0
    ) {
      throw this.fail("contract_mismatch", "frame did not match the negotiated physical contract");
    }
    if (this.previousFrame) {
      if (frame.source_sequence !== this.previousFrame.source_sequence + 1) {
        throw this.fail("source_sequence_gap", "source sequence was not contiguous");
      }
      if (frame.native_pts_us <= this.previousFrame.native_pts_us) {
        throw this.fail("source_stale_reuse", "native presentation timestamp was not increasing");
      }
    }
    this.previousFrame = { ...frame };
  }

  pause(): void {
    if (this.lifecycleValue !== "recording") {
      throw new CaptureBackendV2Error("contract_mismatch", "only a recording backend can pause");
    }
    this.lifecycleValue = "paused";
  }

  resume(): void {
    if (this.lifecycleValue !== "paused") {
      throw new CaptureBackendV2Error("contract_mismatch", "only a paused backend can resume");
    }
    this.lifecycleValue = "recording";
  }

  stop(): boolean {
    if (this.lifecycleValue === "stopped") return false;
    if (
      this.lifecycleValue !== "recording" &&
      this.lifecycleValue !== "paused" &&
      this.lifecycleValue !== "failed"
    ) {
      throw new CaptureBackendV2Error("contract_mismatch", "backend has no active session to stop");
    }
    this.lifecycleValue = "stopped";
    return true;
  }

  fail(code: RecordingQualityFailureCode, message: string): CaptureBackendV2Error {
    if (!this.stickyFailureValue) {
      this.stickyFailureValue = new CaptureBackendV2Error(code, message);
      this.lifecycleValue = "failed";
    }
    return this.stickyFailureValue;
  }
}

import { createHash } from "node:crypto";
import path from "node:path";

import type { CaptureTarget } from "./legacy/shared";
import { recordEngineLog } from "./recording-observability";

export const RECORDING_PREFLIGHT_CACHE_TTL_MS = 10_000;
export const RECORDING_PREFLIGHT_DISK_BLOCK_BYTES = 512 * 1024 * 1024;
export const RECORDING_PREFLIGHT_DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024;

export const RECORDING_PREFLIGHT_CHECK_IDS = [
  "permission",
  "target_live",
  "encoder_available",
  "output_valid",
  "disk_space",
  "audio_device",
  "no_active_session",
] as const;

export type RecordingPreflightCheckId = (typeof RECORDING_PREFLIGHT_CHECK_IDS)[number];
export type RecordingPreflightStatus = "pass" | "warn" | "block";
export type RecordingPreflightMode = "warn" | "block";
export type RecordingAudioRole = "microphone" | "tab" | "system";
export type RecordingAudioPolicy = "required" | "optional";
export type RecordingCapabilityState = "available" | "unavailable" | "unsupported";

export type RecordingPreflightReason =
  | "permission_not_required"
  | "permission_granted"
  | "permission_denied"
  | "permission_restricted"
  | "permission_undetermined"
  | "target_live"
  | "target_missing"
  | "target_thumbnail_unavailable"
  | "encoder_available"
  | "encoder_missing"
  | "encoder_not_file"
  | "encoder_not_executable"
  | "encoder_smoke_failed"
  | "encoder_smoke_timeout"
  | "capture_profile_unsupported"
  | "output_valid"
  | "output_missing"
  | "output_not_directory"
  | "output_not_writable"
  | "disk_space_sufficient"
  | "disk_space_low"
  | "disk_space_critical"
  | "disk_space_unknown"
  | "audio_not_requested"
  | "audio_available"
  | "required_audio_unavailable"
  | "optional_audio_unavailable"
  | "no_active_session"
  | "active_session"
  | "recovery_in_progress"
  | "check_unavailable";

export interface RecordingPreflightAudioRequestV1 {
  role: string;
  policy: RecordingAudioPolicy;
  device_id?: string | null;
}

export interface RecordingPreflightRequestV1 {
  version: 1;
  target: CaptureTarget;
  output_directory: string;
  width: number;
  height: number;
  fps: number;
  audio_roles: RecordingPreflightAudioRequestV1[];
  available_audio_input_ids?: string[];
}

export interface RecordingPreflightCheckV1 {
  id: RecordingPreflightCheckId;
  status: RecordingPreflightStatus;
  reason: RecordingPreflightReason;
  detail: string;
  remediation?: string;
}

export interface RecordingPreflightAudioCapabilityV1 {
  role: string;
  required: boolean;
  state: RecordingCapabilityState;
  reason: string;
}

export interface RecordingPreflightCapabilitiesV1 {
  target: {
    kind: CaptureTarget["kind"];
    electron_capture: RecordingCapabilityState;
    reason: string;
  };
  capture_profile: {
    width: number;
    height: number;
    fps: number;
    state: RecordingCapabilityState;
    reason: string;
  };
  encoder: {
    state: RecordingCapabilityState;
    reason: string;
  };
  audio: RecordingPreflightAudioCapabilityV1[];
}

export interface RecordingPreflightReportV1 {
  version: 1;
  mode: RecordingPreflightMode;
  checked_at: string;
  fingerprint: string;
  verdict: RecordingPreflightStatus;
  checks: RecordingPreflightCheckV1[];
  capabilities: RecordingPreflightCapabilitiesV1;
}

export interface RecordingPreflightTargetSource {
  id: string;
  name: string;
  display_id?: string | null;
  window_id?: string | number | null;
  pid?: number | null;
  thumbnail_available: boolean;
}

export interface RecordingPreflightEncoderInspection {
  path: string | null;
  exists: boolean;
  is_file: boolean;
  executable: boolean;
}

export interface RecordingPreflightOutputInspection {
  exists: boolean;
  is_directory: boolean;
  writable: boolean;
  free_bytes: number | null;
}

export interface RecordingPreflightRoleCapability {
  state: RecordingCapabilityState;
  reason: string;
}

export interface RecordingPreflightProfileCapability {
  supported: boolean;
  reason: string;
}

export interface RecordingPreflightDependencies {
  now: () => number;
  getScreenPermission: () => Promise<"granted" | "denied" | "restricted" | "undetermined">;
  listCaptureSources: (
    kind: "screen" | "window",
  ) => Promise<readonly RecordingPreflightTargetSource[]>;
  inspectAuthorPreview: (
    streamId: string,
  ) => Promise<{ live: boolean; thumbnail_available: boolean }>;
  inspectEncoder: () => Promise<RecordingPreflightEncoderInspection>;
  smokeEncoder: (binaryPath: string, signal: AbortSignal) => Promise<boolean>;
  inspectOutputDirectory: (outputDirectory: string) => Promise<RecordingPreflightOutputInspection>;
  listAudioInputIds: () => Promise<readonly string[]>;
  getAudioRoleCapability: (
    role: RecordingAudioRole,
    target: CaptureTarget,
  ) => Promise<RecordingPreflightRoleCapability>;
  getProfileCapability: (
    profile: { width: number; height: number; fps: number },
    target: CaptureTarget,
  ) => Promise<RecordingPreflightProfileCapability>;
  getStartupGate: () => Promise<{ active_session: boolean; recovery_holds_gate: boolean }>;
}

export interface RecordingPreflightValidatorOptions {
  mode?: RecordingPreflightMode;
  encoderSmokeTimeoutMs?: number;
}

interface TargetResult {
  check: RecordingPreflightCheckV1;
  capability: RecordingPreflightCapabilitiesV1["target"];
}

interface EncoderResult {
  check: RecordingPreflightCheckV1;
  encoder: RecordingPreflightCapabilitiesV1["encoder"];
  profile: RecordingPreflightCapabilitiesV1["capture_profile"];
}

interface OutputResult {
  output: RecordingPreflightCheckV1;
  disk: RecordingPreflightCheckV1;
}

interface AudioResult {
  check: RecordingPreflightCheckV1;
  capabilities: RecordingPreflightAudioCapabilityV1[];
}

interface CachedReport {
  checkedAtMs: number;
  fingerprint: string;
  report: RecordingPreflightReportV1;
}

class EncoderSmokeTimeoutError extends Error {}

const AUDIO_ROLE_ORDER = new Map<RecordingAudioRole, number>([
  ["microphone", 0],
  ["tab", 1],
  ["system", 2],
]);

function check(
  id: RecordingPreflightCheckId,
  status: RecordingPreflightStatus,
  reason: RecordingPreflightReason,
  detail: string,
  remediation?: string,
): RecordingPreflightCheckV1 {
  return remediation ? { id, status, reason, detail, remediation } : { id, status, reason, detail };
}

function canonicalTarget(target: CaptureTarget): Record<string, unknown> {
  switch (target.kind) {
    case "display":
      return { kind: target.kind, display_id: String(target.display_id) };
    case "window":
      return { kind: target.kind, window_id: String(target.window_id) };
    case "window_by_pid":
      return { kind: target.kind, pid: target.pid, title_hint: target.title_hint };
    case "author_preview":
      return { kind: target.kind, stream_id: target.stream_id };
    case "display_region":
      return {
        kind: target.kind,
        display_id: String(target.display_id),
        rect: { x: target.rect.x, y: target.rect.y, w: target.rect.w, h: target.rect.h },
      };
  }
}

function canonicalAudioRoles(
  roles: readonly RecordingPreflightAudioRequestV1[],
): RecordingPreflightAudioRequestV1[] {
  return roles
    .map((role) => ({
      role: String(role.role),
      policy: role.policy,
      device_id: role.device_id == null ? null : String(role.device_id),
    }))
    .sort((left, right) => {
      const leftOrder = AUDIO_ROLE_ORDER.get(left.role as RecordingAudioRole) ?? 99;
      const rightOrder = AUDIO_ROLE_ORDER.get(right.role as RecordingAudioRole) ?? 99;
      return (
        leftOrder - rightOrder ||
        left.role.localeCompare(right.role) ||
        left.policy.localeCompare(right.policy) ||
        String(left.device_id).localeCompare(String(right.device_id))
      );
    });
}

export function fingerprintRecordingPreflightRequest(request: RecordingPreflightRequestV1): string {
  const canonical = {
    version: 1,
    target: canonicalTarget(request.target),
    output_directory: path.resolve(String(request.output_directory)),
    width: request.width,
    height: request.height,
    fps: request.fps,
    audio_roles: canonicalAudioRoles(request.audio_roles),
    available_audio_input_ids: [...new Set(request.available_audio_input_ids ?? [])].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function parsedSourceWindowId(source: RecordingPreflightTargetSource): string | null {
  if (source.window_id != null) return String(source.window_id);
  const raw = source.id.split(":")[1];
  if (!raw) return null;
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? String(numeric) : null;
}

export function resolveExactPreflightTarget(
  target: Exclude<CaptureTarget, { kind: "author_preview" }>,
  sources: readonly RecordingPreflightTargetSource[],
): RecordingPreflightTargetSource | null {
  return (
    sources.find((source) => {
      switch (target.kind) {
        case "display":
        case "display_region":
          return (
            source.display_id != null && String(source.display_id) === String(target.display_id)
          );
        case "window":
          return parsedSourceWindowId(source) === String(target.window_id);
        case "window_by_pid":
          return (
            source.pid === target.pid &&
            (!target.title_hint || source.name.includes(target.title_hint))
          );
      }
      return false;
    }) ?? null
  );
}

function knownAudioRole(role: string): role is RecordingAudioRole {
  return role === "microphone" || role === "tab" || role === "system";
}

function severity(status: RecordingPreflightStatus): number {
  return status === "block" ? 2 : status === "warn" ? 1 : 0;
}

function reportVerdict(checks: readonly RecordingPreflightCheckV1[]): RecordingPreflightStatus {
  return checks.reduce<RecordingPreflightStatus>(
    (current, item) => (severity(item.status) > severity(current) ? item.status : current),
    "pass",
  );
}

async function withTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EncoderSmokeTimeoutError("encoder smoke timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class RecordingPreflightValidator {
  readonly #deps: RecordingPreflightDependencies;
  readonly #mode: RecordingPreflightMode;
  readonly #encoderSmokeTimeoutMs: number;
  #cache: CachedReport | null = null;

  constructor(
    dependencies: RecordingPreflightDependencies,
    options: RecordingPreflightValidatorOptions = {},
  ) {
    this.#deps = dependencies;
    this.#mode = options.mode ?? "warn";
    this.#encoderSmokeTimeoutMs = Math.max(1, options.encoderSmokeTimeoutMs ?? 2_500);
  }

  async run(
    request: RecordingPreflightRequestV1,
    options: { force?: boolean } = {},
  ): Promise<RecordingPreflightReportV1> {
    const fingerprint = fingerprintRecordingPreflightRequest(request);
    const startedAt = this.#deps.now();
    const age = this.#cache ? startedAt - this.#cache.checkedAtMs : Number.POSITIVE_INFINITY;
    if (
      !options.force &&
      this.#cache?.fingerprint === fingerprint &&
      age >= 0 &&
      age <= RECORDING_PREFLIGHT_CACHE_TTL_MS
    ) {
      void recordEngineLog({
        event: "recording.preflight.completed",
        context: {
          request_id: fingerprint,
          phase: "preflight",
          duration_ms: Math.max(0, this.#deps.now() - startedAt),
        },
        details: {
          cached: true,
          mode: this.#cache.report.mode,
          verdict: this.#cache.report.verdict,
        },
      });
      return this.#cache.report;
    }

    const [permission, target, encoder, output, audio, startup] = await Promise.all([
      this.#permissionCheck(request.target),
      this.#targetCheck(request.target),
      this.#encoderCheck(request),
      this.#outputChecks(request.output_directory),
      this.#audioCheck(request.audio_roles, request.target, request.available_audio_input_ids),
      this.#startupCheck(),
    ]);
    const checks = [
      permission,
      target.check,
      encoder.check,
      output.output,
      output.disk,
      audio.check,
      startup,
    ];
    const checkedAtMs = this.#deps.now();
    const report: RecordingPreflightReportV1 = {
      version: 1,
      mode: this.#mode,
      checked_at: new Date(checkedAtMs).toISOString(),
      fingerprint,
      verdict: reportVerdict(checks),
      checks,
      capabilities: {
        target: target.capability,
        capture_profile: encoder.profile,
        encoder: encoder.encoder,
        audio: audio.capabilities,
      },
    };
    this.#cache = { checkedAtMs, fingerprint, report };
    void recordEngineLog({
      level: report.verdict === "block" ? "warn" : "info",
      event: "recording.preflight.completed",
      context: {
        request_id: fingerprint,
        phase: "preflight",
        duration_ms: Math.max(0, checkedAtMs - startedAt),
      },
      details: {
        cached: false,
        mode: report.mode,
        verdict: report.verdict,
        check_statuses: report.checks.map((item) => ({
          id: item.id,
          status: item.status,
          reason: item.reason,
        })),
      },
    });
    return report;
  }

  async #permissionCheck(target: CaptureTarget): Promise<RecordingPreflightCheckV1> {
    if (target.kind === "author_preview") {
      return check(
        "permission",
        "pass",
        "permission_not_required",
        "Author preview capture does not require operating-system screen permission.",
      );
    }
    try {
      const state = await this.#deps.getScreenPermission();
      if (state === "granted") {
        return check(
          "permission",
          "pass",
          "permission_granted",
          "Screen capture permission is granted.",
        );
      }
      const reason =
        state === "denied"
          ? "permission_denied"
          : state === "restricted"
            ? "permission_restricted"
            : "permission_undetermined";
      return check(
        "permission",
        "block",
        reason,
        "Screen capture permission is not granted for this target.",
        "Review screen-recording permission for StoryCapture.",
      );
    } catch {
      return check(
        "permission",
        "block",
        "check_unavailable",
        "Screen capture permission could not be checked.",
        "Retry preflight before recording.",
      );
    }
  }

  async #targetCheck(target: CaptureTarget): Promise<TargetResult> {
    try {
      const inspection =
        target.kind === "author_preview"
          ? await this.#deps.inspectAuthorPreview(target.stream_id)
          : await this.#inspectExternalTarget(target);
      if (!inspection.live) {
        return {
          check: check(
            "target_live",
            "block",
            "target_missing",
            "The selected capture target is no longer available.",
            "Select the capture target again.",
          ),
          capability: {
            kind: target.kind,
            electron_capture: "unavailable",
            reason: "target_missing",
          },
        };
      }
      if (!inspection.thumbnail_available) {
        return {
          check: check(
            "target_live",
            "block",
            "target_thumbnail_unavailable",
            "The selected capture target cannot provide a liveness thumbnail.",
            "Select the capture target again.",
          ),
          capability: {
            kind: target.kind,
            electron_capture: "unavailable",
            reason: "target_thumbnail_unavailable",
          },
        };
      }
      return {
        check: check(
          "target_live",
          "pass",
          "target_live",
          "The selected capture target is available.",
        ),
        capability: { kind: target.kind, electron_capture: "available", reason: "target_live" },
      };
    } catch {
      return {
        check: check(
          "target_live",
          "block",
          "check_unavailable",
          "The selected capture target could not be checked.",
          "Select the capture target again.",
        ),
        capability: {
          kind: target.kind,
          electron_capture: "unavailable",
          reason: "check_unavailable",
        },
      };
    }
  }

  async #inspectExternalTarget(
    target: Exclude<CaptureTarget, { kind: "author_preview" }>,
  ): Promise<{ live: boolean; thumbnail_available: boolean }> {
    const sourceKind =
      target.kind === "window" || target.kind === "window_by_pid" ? "window" : "screen";
    const sources = await this.#deps.listCaptureSources(sourceKind);
    const exact = resolveExactPreflightTarget(target, sources);
    return exact
      ? { live: true, thumbnail_available: exact.thumbnail_available }
      : { live: false, thumbnail_available: false };
  }

  async #encoderCheck(request: RecordingPreflightRequestV1): Promise<EncoderResult> {
    const profile = {
      width: request.width,
      height: request.height,
      fps: request.fps,
      state: "unsupported" as RecordingCapabilityState,
      reason: "check_unavailable",
    };
    let profileUnavailable = false;
    try {
      const capability = await this.#deps.getProfileCapability(
        { width: request.width, height: request.height, fps: request.fps },
        request.target,
      );
      profile.state = capability.supported ? "available" : "unsupported";
      profile.reason = capability.reason;
    } catch {
      profileUnavailable = true;
    }

    let inspection: RecordingPreflightEncoderInspection;
    try {
      inspection = await this.#deps.inspectEncoder();
    } catch {
      return {
        check: check(
          "encoder_available",
          "block",
          "check_unavailable",
          "The recording encoder could not be checked.",
          "Retry preflight before recording.",
        ),
        encoder: { state: "unavailable", reason: "check_unavailable" },
        profile,
      };
    }

    const unavailable = (
      reason: Extract<
        RecordingPreflightReason,
        "encoder_missing" | "encoder_not_file" | "encoder_not_executable"
      >,
      detail: string,
    ): EncoderResult => ({
      check: check(
        "encoder_available",
        "block",
        reason,
        detail,
        "Repair or reinstall the desktop application.",
      ),
      encoder: { state: "unavailable", reason },
      profile,
    });
    const binaryPath = inspection.path;
    if (!binaryPath || !inspection.exists) {
      return unavailable("encoder_missing", "The recording encoder is missing.");
    }
    if (!inspection.is_file) {
      return unavailable("encoder_not_file", "The recording encoder path is not a file.");
    }
    if (!inspection.executable) {
      return unavailable("encoder_not_executable", "The recording encoder is not executable.");
    }

    try {
      const passed = await withTimeout(this.#encoderSmokeTimeoutMs, (signal) =>
        this.#deps.smokeEncoder(binaryPath, signal),
      );
      if (!passed) {
        return {
          check: check(
            "encoder_available",
            "block",
            "encoder_smoke_failed",
            "The recording encoder failed its read-only smoke check.",
            "Repair or reinstall the desktop application.",
          ),
          encoder: { state: "unavailable", reason: "encoder_smoke_failed" },
          profile,
        };
      }
    } catch (error) {
      const timedOut = error instanceof EncoderSmokeTimeoutError;
      return {
        check: check(
          "encoder_available",
          "block",
          timedOut ? "encoder_smoke_timeout" : "check_unavailable",
          timedOut
            ? "The recording encoder smoke check timed out."
            : "The recording encoder could not be checked.",
          "Retry preflight before recording.",
        ),
        encoder: {
          state: "unavailable",
          reason: timedOut ? "encoder_smoke_timeout" : "check_unavailable",
        },
        profile,
      };
    }

    if (profileUnavailable) {
      return {
        check: check(
          "encoder_available",
          "block",
          "check_unavailable",
          "The requested capture profile could not be checked.",
          "Retry preflight before recording.",
        ),
        encoder: { state: "available", reason: "encoder_available" },
        profile,
      };
    }
    if (profile.state !== "available") {
      return {
        check: check(
          "encoder_available",
          "block",
          "capture_profile_unsupported",
          "The requested resolution or frame rate is unsupported.",
          "Choose a supported recording profile.",
        ),
        encoder: { state: "available", reason: "encoder_available" },
        profile,
      };
    }
    return {
      check: check(
        "encoder_available",
        "pass",
        "encoder_available",
        "The recording encoder and capture profile are available.",
      ),
      encoder: { state: "available", reason: "encoder_available" },
      profile,
    };
  }

  async #outputChecks(outputDirectory: string): Promise<OutputResult> {
    let inspection: RecordingPreflightOutputInspection;
    try {
      inspection = await this.#deps.inspectOutputDirectory(path.resolve(String(outputDirectory)));
    } catch {
      return {
        output: check(
          "output_valid",
          "block",
          "check_unavailable",
          "The output directory could not be checked.",
          "Choose an accessible output directory.",
        ),
        disk: check(
          "disk_space",
          "block",
          "check_unavailable",
          "Available disk space could not be checked.",
          "Retry preflight before recording.",
        ),
      };
    }

    const output = !inspection.exists
      ? check(
          "output_valid",
          "block",
          "output_missing",
          "The output directory does not exist.",
          "Choose an existing output directory.",
        )
      : !inspection.is_directory
        ? check(
            "output_valid",
            "block",
            "output_not_directory",
            "The selected output location is not a directory.",
            "Choose an output directory.",
          )
        : !inspection.writable
          ? check(
              "output_valid",
              "block",
              "output_not_writable",
              "The output directory is not writable.",
              "Choose a writable output directory.",
            )
          : check("output_valid", "pass", "output_valid", "The output directory is writable.");

    const freeBytes = inspection.free_bytes;
    let disk: RecordingPreflightCheckV1;
    if (freeBytes == null || !Number.isFinite(freeBytes) || freeBytes < 0) {
      disk = check(
        "disk_space",
        this.#mode === "block" ? "block" : "warn",
        "disk_space_unknown",
        "Available disk space could not be determined.",
        "Verify free disk space before recording.",
      );
    } else if (freeBytes < RECORDING_PREFLIGHT_DISK_BLOCK_BYTES) {
      disk = check(
        "disk_space",
        "block",
        "disk_space_critical",
        "Less than 512 MiB of disk space is available.",
        "Free disk space before recording.",
      );
    } else if (freeBytes < RECORDING_PREFLIGHT_DISK_WARN_BYTES) {
      disk = check(
        "disk_space",
        "warn",
        "disk_space_low",
        "Less than 2 GiB of disk space is available.",
        "Free disk space for longer recordings.",
      );
    } else {
      disk = check(
        "disk_space",
        "pass",
        "disk_space_sufficient",
        "At least 2 GiB of disk space is available.",
      );
    }
    return { output, disk };
  }

  async #audioCheck(
    requestedRoles: readonly RecordingPreflightAudioRequestV1[],
    target: CaptureTarget,
    availableAudioInputIds?: readonly string[],
  ): Promise<AudioResult> {
    const roles = canonicalAudioRoles(requestedRoles);
    if (roles.length === 0) {
      return {
        check: check("audio_device", "pass", "audio_not_requested", "No audio role was requested."),
        capabilities: [],
      };
    }

    let audioInputIds: readonly string[] | null = null;
    let audioInputEnumerationFailed = false;
    const capabilities: RecordingPreflightAudioCapabilityV1[] = [];
    for (const requested of roles) {
      const required = requested.policy === "required";
      if (!knownAudioRole(requested.role)) {
        capabilities.push({
          role: requested.role,
          required,
          state: "unsupported",
          reason: "unsupported_audio_role",
        });
        continue;
      }
      if (requested.role === "microphone") {
        if (!requested.device_id) {
          capabilities.push({
            role: requested.role,
            required,
            state: "unavailable",
            reason: "microphone_device_id_missing",
          });
          continue;
        }
        if (audioInputIds === null && availableAudioInputIds) {
          audioInputIds = availableAudioInputIds;
        }
        if (audioInputIds === null) {
          try {
            audioInputIds = await this.#deps.listAudioInputIds();
          } catch {
            audioInputIds = [];
            audioInputEnumerationFailed = true;
          }
        }
        if (audioInputEnumerationFailed) {
          capabilities.push({
            role: requested.role,
            required,
            state: "unavailable",
            reason: "check_unavailable",
          });
          continue;
        }
        if (!audioInputIds.includes(requested.device_id)) {
          capabilities.push({
            role: requested.role,
            required,
            state: "unavailable",
            reason: "microphone_device_not_found",
          });
          continue;
        }
      }
      try {
        const capability = await this.#deps.getAudioRoleCapability(requested.role, target);
        capabilities.push({ role: requested.role, required, ...capability });
      } catch {
        capabilities.push({
          role: requested.role,
          required,
          state: "unavailable",
          reason: "check_unavailable",
        });
      }
    }

    const unavailableRequired = capabilities.some(
      (capability) => capability.required && capability.state !== "available",
    );
    const unavailableOptional = capabilities.some(
      (capability) => !capability.required && capability.state !== "available",
    );
    if (unavailableRequired) {
      return {
        check: check(
          "audio_device",
          "block",
          "required_audio_unavailable",
          "At least one required audio role is unavailable or unsupported.",
          "Choose an available audio source or change its policy.",
        ),
        capabilities,
      };
    }
    if (unavailableOptional) {
      return {
        check: check(
          "audio_device",
          "warn",
          "optional_audio_unavailable",
          "At least one optional audio role is unavailable or unsupported.",
          "Continue without that optional source or choose another source.",
        ),
        capabilities,
      };
    }
    return {
      check: check(
        "audio_device",
        "pass",
        "audio_available",
        "All requested audio roles are available.",
      ),
      capabilities,
    };
  }

  async #startupCheck(): Promise<RecordingPreflightCheckV1> {
    try {
      const gate = await this.#deps.getStartupGate();
      if (gate.active_session) {
        return check(
          "no_active_session",
          "block",
          "active_session",
          "Another recording session is active.",
          "Stop or cancel the active recording before starting another.",
        );
      }
      if (gate.recovery_holds_gate) {
        return check(
          "no_active_session",
          "block",
          "recovery_in_progress",
          "Interrupted-recording recovery currently holds the startup gate.",
          "Finish or discard the interrupted-recording recovery first.",
        );
      }
      return check(
        "no_active_session",
        "pass",
        "no_active_session",
        "No recording or recovery operation is holding the startup gate.",
      );
    } catch {
      return check(
        "no_active_session",
        "block",
        "check_unavailable",
        "Recording lifecycle availability could not be checked.",
        "Retry preflight before recording.",
      );
    }
  }
}

export class AcceptedRecordingPreflightRegistry {
  readonly #reports = new Map<string, Readonly<RecordingPreflightReportV1>>();

  accept(sessionId: string, report: Readonly<RecordingPreflightReportV1>): void {
    const id = String(sessionId).trim();
    if (!id) throw new Error("accepted recording preflight requires session id");
    if (report.version !== 1) throw new Error("accepted recording preflight requires version 1");
    this.#reports.set(id, report);
  }

  get(sessionId: string): Readonly<RecordingPreflightReportV1> | null {
    return this.#reports.get(sessionId) ?? null;
  }

  remove(sessionId: string): void {
    this.#reports.delete(sessionId);
  }
}

export const acceptedRecordingPreflights = new AcceptedRecordingPreflightRegistry();

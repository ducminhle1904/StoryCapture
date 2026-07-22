import type {
  RecordingCaptureContractV3,
  RecordingPreflightDto,
  RecordingPreflightV3Dto,
  StartRecordingArgs,
} from "@storycapture/shared-types";
import { recordingV3FailureMessage } from "@storycapture/shared-types/recording-v2";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  Monitor,
  Pause,
  Settings as SettingsIcon,
  Square as StopIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { TargetPicker } from "@/features/capture/TargetPicker";
import type { ProjectWorkflowSnapshot } from "@/features/project-workflow/project-stage";
import { ProjectStageHeader } from "@/features/project-workflow/project-stage-header";
import {
  type AutomationChannelHandle,
  type ExecutorEvent,
  launchAutomation,
} from "@/ipc/automation";
import {
  type CaptureTarget,
  checkScreenCapturePermission,
  type DisplayInfo,
  isStageManagerEnabled,
  openScreenCapturePrefs,
  relaunchApp,
  requestScreenCaptureAccess,
  type ScreenCapturePermissionReport,
} from "@/ipc/capture";
import {
  acknowledgeRecordingV3,
  pauseRecording,
  probeRecordingV3Capability,
  queryRecordingV3Sessions,
  type RecordingCompletedResult,
  type RecordingEvent,
  type RecordingSessionId,
  type RecordingStopResult,
  reattachRecordingV3,
  resumeRecording,
  startRecording,
  stopRecording,
} from "@/ipc/encode";
import { parseStory } from "@/ipc/parse";
import { publishCompletedRecording } from "@/ipc/projects";
import { queryClient } from "@/ipc/query-client";
import {
  deleteFailedRecordingBundle,
  openRecordingDiagnosticBundle,
} from "@/ipc/recording-failure";
import { frontendLog } from "@/lib/log";
import { useAppSettingsStore } from "@/state/app-settings";
import {
  applyCaptureFpsDefault,
  DEFAULT_RECORDING_PACING,
  recordingOutputResolutionForStart,
  useOutputPrefsStore,
} from "@/state/output-prefs";
import { type RecorderStatus, type StepProgress, useRecorderStore } from "@/state/recorder";

// The recorder-side element picker has been removed. Element picking
// lives exclusively in the Preview panel via
// `apps/desktop/src/features/editor/PreviewPickerButton.tsx`.
import { AudioDevicePicker } from "./AudioDevicePicker";
import { ChromeHidingToggle } from "./ChromeHidingToggle";
import { CursorToggle } from "./CursorToggle";
import { formatIpcError } from "./ipc-error";
import { parsePrimaryMiss, RECORD_PATH_MISS_BODY } from "./primary-miss-copy";
import { acquireRecordingPreview, type RecordingPreviewLease } from "./recording-preview";
import { canFinalizeOwnedRecording } from "./recording-session-lifecycle";
import { authorPreviewRecordingPlan } from "./recording-target";
import { storyInitialUrlForRecording, storyViewportSize } from "./recording-viewport";
import { TccPrompt } from "./tcc-prompt";
import { OutputSummaryBadge } from "./video-output/output-summary-badge";
import { useIsRecordingBlocked, VideoOutputSection } from "./video-output/video-output-section";

interface RecordingViewProps {
  projectId: string | null;
  projectName: string;
  projectFolder: string;
  storySource: string;
  existingRecordingCount?: number;
  autoOpenPostProduction?: boolean;
}

const initialPermissionReport: ScreenCapturePermissionReport = {
  state: "undetermined",
  rawStatus: "unknown",
  platform: "darwin",
  appName: "StoryCapture",
  bundleId: null,
  executablePath: "",
  isPackaged: false,
  devIdentityOk: null,
  canEnumerateSources: false,
  sourceCount: 0,
  debugBypassAllowed: false,
};

function recordingV3CaptureContract(
  logicalWidth: number,
  logicalHeight: number,
): RecordingCaptureContractV3 {
  return {
    version: 3,
    guarantee_boundary: "electron_offscreen_delivery",
    source_ordinal_kind: "electron_frame_count",
    target_class: "browser",
    exact_fps: { numerator: 60, denominator: 1 },
    dimensions: {
      logical_width: logicalWidth,
      logical_height: logicalHeight,
      capture_dpr: 2,
      physical_width: logicalWidth * 2,
      physical_height: logicalHeight * 2,
      requested_output_width: 1920,
      requested_output_height: 1080,
    },
    cursor_policy: "sidecar_reconstructed",
    audio_roles: [],
  };
}

function recordingV3FailureSummary(preflight: RecordingPreflightV3Dto): string {
  return preflight.failure_codes.map(recordingV3FailureMessage).join(" ");
}

function recordingPreflightEligible(
  preflight: RecordingPreflightDto,
  developmentMode = preflight.version === 3 && preflight.intent === "development",
): boolean {
  if (developmentMode) {
    return preflight.version === 3 && preflight.development_eligible;
  }
  return preflight.strict_eligible;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** True if a Tauri IPC error is the typed `NotFound` variant. */
function isNotFoundIpcError(e: unknown): boolean {
  if (typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "NotFound") {
    return true;
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /recording session .* not found/i.test(message);
}

function displayId(display: DisplayInfo): number {
  return typeof display.id === "bigint" ? Number(display.id) : display.id;
}

export function RecordingView({
  projectId,
  projectName,
  projectFolder,
  storySource,
  existingRecordingCount = 0,
  autoOpenPostProduction = false,
}: RecordingViewProps) {
  const navigate = useNavigate();
  const {
    status,
    sessionId,
    currentStep,
    steps,
    error,
    outputPath,
    elapsedMs,
    preflight,
    liveEvidence,
    verificationProgress,
    qualityFailure,
    captureTarget,
    availableTargets,
    audioDeviceId,
    setAudioDeviceId,
    includeCursor,
    setIncludeCursor,
    chromeHiding,
    setChromeHiding,
    setStatus,
    setSession,
    setSteps,
    advanceStep,
    pushCursor,
    setError,
    setOutputPath,
    setElapsed,
    setPreflight,
    setReadiness,
    setLiveEvidence,
    setVerificationProgress,
    setQualityFailure,
    resetTake,
    reset,
    loadCaptureTargets,
    setCaptureTarget,
    setPrimaryMiss,
  } = useRecorderStore();

  // Audio-negotiation failure persists a session-scoped flag so a
  // "video-only" badge stays visible next to the Live pill until the user
  // starts a new recording.
  const [audioUnavailable, setAudioUnavailable] = useState(false);

  // Host heartbeat watchdog. `lastHeartbeatRef` is last-tick epoch-ms
  // (null before first heartbeat). `desynced` surfaces the "out of sync" UI.
  const lastHeartbeatRef = useRef<number | null>(null);
  const [desynced, setDesynced] = useState(false);

  // Reference to the automation Channel so unmount can null its handler.
  const automationChannelRef = useRef<AutomationChannelHandle | null>(null);

  // Mirror the active browser preset for ChromeHidingToggle.
  const [browserPreset, setBrowserPreset] = useState<string | null>(null);
  const appSettings = useAppSettingsStore((s) => s.settings);
  const recordingDeliveryPolicy = useOutputPrefsStore((s) => s.recordingDeliveryPolicy);
  const recordingV3DevelopmentMode = useOutputPrefsStore((s) => s.recordingV3DevelopmentMode);

  const applyRecorderDefaults = () => {
    const capture = useAppSettingsStore.getState().settings?.capture;
    setAudioDeviceId(capture?.audio_input_default === "system_default" ? "default" : null);
    setIncludeCursor(capture?.include_cursor_default ?? false);
    if (capture) applyCaptureFpsDefault(capture);
  };

  useEffect(() => {
    setBrowserPreset(appSettings?.browser_executable ?? null);
  }, [appSettings?.browser_executable]);

  useEffect(() => {
    applyRecorderDefaults();
    // Run when persisted defaults hydrate/change; setter identities are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettings?.capture]);

  const reduceMotion = useReducedMotion();
  const [permissionReport, setPermissionReport] =
    useState<ScreenCapturePermissionReport>(initialPermissionReport);
  const permission = permissionReport.state;
  const [tccOpen, setTccOpen] = useState(false);
  // Local state only drives the countdown affordance.
  const [useCountdown, setUseCountdown] = useState(true);
  // Stage Manager breaks SCK window-target capture for off-stage
  // windows — surface a pre-flight warning so users can disable it
  // before recording, matching Screen Studio / CleanShot X UX.
  const [stageManagerWarning, setStageManagerWarning] = useState(false);

  const sessionRef = useRef<RecordingSessionId | null>(null);
  const recordingContractVersionRef = useRef<2 | 3>(2);
  const completedSessionRef = useRef<string | null>(null);
  const previewLeaseRef = useRef<RecordingPreviewLease | null>(null);
  const previewSessionRef = useRef<string | null>(null);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const automationOwnsStopRef = useRef(false);
  const automationSessionRef = useRef<string | null>(null);
  const automationFailedOrdinalRef = useRef<number | null>(null);
  const handleRecordRef = useRef<(() => Promise<void>) | null>(null);
  const handleStopRef = useRef<((expectedSessionId?: string) => Promise<void>) | null>(null);
  const v3ReattachHandlersRef = useRef<{
    dispatch: (ownerSessionId: string, event: RecordingEvent) => void;
    finalize: (ownerSessionId: string, result: RecordingCompletedResult) => void;
    fail: (ownerSessionId: string, message: string) => void;
    failQuality: (
      ownerSessionId: string,
      result: Extract<RecordingStopResult, { status: "quality_failed" }>,
    ) => void;
  } | null>(null);
  const videoOutputSectionRef = useRef<HTMLDivElement | null>(null);
  const isOutputBlocked = useIsRecordingBlocked();

  const displays = availableTargets?.displays ?? [];
  const selectedDisplay: number | null =
    captureTarget?.kind === "display"
      ? typeof captureTarget.display_id === "bigint"
        ? Number(captureTarget.display_id)
        : captureTarget.display_id
      : null;
  const selectedDisplayInfo = useMemo(
    () =>
      selectedDisplay == null
        ? undefined
        : displays.find((display) => displayId(display) === selectedDisplay),
    [displays, selectedDisplay],
  );
  const storyRecordingInfo = useMemo(() => {
    const initialUrl = storyInitialUrlForRecording(storySource);
    return {
      initialUrl,
      hasBrowser: initialUrl != null || /\bapp\s*:\s*["']https?:\/\//i.test(storySource),
      viewport: storyViewportSize(storySource),
    };
  }, [storySource]);
  const storyHasBrowser = storyRecordingInfo.hasBrowser;
  const storyViewport = storyRecordingInfo.viewport;
  const storyInitialUrl = storyRecordingInfo.initialUrl;
  const selectedCaptureDims = useMemo(() => {
    const dims = storyHasBrowser
      ? { w: storyViewport.width, h: storyViewport.height }
      : selectedDisplayInfo
        ? { w: selectedDisplayInfo.width_px, h: selectedDisplayInfo.height_px }
        : null;
    if (
      !dims ||
      !Number.isFinite(dims.w) ||
      !Number.isFinite(dims.h) ||
      dims.w <= 0 ||
      dims.h <= 0
    ) {
      return undefined;
    }
    return dims;
  }, [selectedDisplayInfo, storyHasBrowser, storyViewport.height, storyViewport.width]);
  const strictUnavailableReason = useMemo(() => {
    if (recordingDeliveryPolicy !== "strict" && !recordingV3DevelopmentMode) return null;
    if (permission !== "granted") return recordingV3FailureMessage("permission_denied");
    if (!storyHasBrowser) return recordingV3FailureMessage("target_unsupported");
    if (audioDeviceId) return recordingV3FailureMessage("unsupported_audio_role");
    if (storyViewport.width !== 960 || storyViewport.height !== 540) {
      return `${recordingV3FailureMessage("contract_mismatch")} Recording V3 requires a 960×540 browser viewport.`;
    }
    if (
      preflight?.version === 3 &&
      !recordingPreflightEligible(preflight, recordingV3DevelopmentMode)
    ) {
      return recordingV3FailureSummary(preflight);
    }
    return null;
  }, [
    audioDeviceId,
    permission,
    preflight,
    recordingDeliveryPolicy,
    recordingV3DevelopmentMode,
    storyHasBrowser,
    storyViewport.height,
    storyViewport.width,
  ]);

  const strictCapabilityInputs = `${audioDeviceId ?? "none"}:${permission}:${recordingDeliveryPolicy}:${recordingV3DevelopmentMode}:${storyHasBrowser}:${storyViewport.width}x${storyViewport.height}`;
  useEffect(() => {
    void strictCapabilityInputs;
    if (useRecorderStore.getState().status === "idle") setPreflight(null);
  }, [setPreflight, strictCapabilityInputs]);

  const currentStepEntry = steps.length > 0 ? steps[Math.min(currentStep, steps.length - 1)] : null;
  const completedSteps = steps.filter((s) => s.status === "succeeded").length;

  const releasePreviewLease = () => {
    previewLeaseRef.current?.release();
    previewLeaseRef.current = null;
    previewSessionRef.current = null;
  };

  const sessionKey = (session: RecordingSessionId): string =>
    typeof (session as unknown) === "string" ? (session as unknown as string) : session.id;

  const ownsActiveSession = (ownerSessionId: string): boolean =>
    sessionRef.current != null && sessionKey(sessionRef.current) === ownerSessionId;

  const cleanupSessionResources = (ownerSessionId: string) => {
    if (automationSessionRef.current === ownerSessionId) {
      if (automationChannelRef.current) automationChannelRef.current.onmessage = null;
      automationChannelRef.current = null;
      automationSessionRef.current = null;
      automationOwnsStopRef.current = false;
      automationFailedOrdinalRef.current = null;
    }
    if (stopInFlightRef.current === ownerSessionId) stopInFlightRef.current = null;
    if (previewSessionRef.current === ownerSessionId) releasePreviewLease();
  };

  const acknowledgeTerminalSession = (ownerSessionId: string) => {
    if (recordingContractVersionRef.current !== 3) return;
    void acknowledgeRecordingV3(ownerSessionId).catch((ackError) => {
      frontendLog.warn("RecordingView", "Recording V3 terminal acknowledgement failed", {
        error: ackError,
        fields: { session_id: ownerSessionId },
      });
    });
  };

  // Detect Stage Manager once on mount (user can toggle it at any time
  // but the cost of not re-polling is a stale banner — acceptable).
  useEffect(() => {
    isStageManagerEnabled()
      .then(setStageManagerWarning)
      .catch(() => {
        /* non-fatal; default off */
      });
  }, []);

  // Preflight and enumerate targets on mount.
  useEffect(() => {
    (async () => {
      try {
        let report = await checkScreenCapturePermission();
        if (report.state !== "granted") {
          report = await requestScreenCaptureAccess();
        }
        setPermissionReport(report);
        if (report.state === "granted") {
          try {
            await loadCaptureTargets();
          } catch (e) {
            setError(`loadCaptureTargets failed: ${formatIpcError(e)}`);
          }
        }
      } catch (e) {
        setError(formatIpcError(e));
      }
    })();
    // Unmount teardown. Cleanup MUST be synchronous; the detached
    // stopRecording promise handles any backend teardown.
    return () => {
      // (a) null the automation Channel handler so no stale event
      //     dispatch runs against an unmounted tree.
      if (automationChannelRef.current) {
        automationChannelRef.current.onmessage = null;
      }
      // (b) if a session is live server-side, fire-and-forget a stop so
      //     the host drain doesn't leak a session. V3 remains host-owned
      //     so a remounted renderer can query and reattach to it.
      const sid = sessionRef.current;
      const contractVersion = recordingContractVersionRef.current;
      sessionRef.current = null;
      if (sid && contractVersion !== 3) {
        void stopRecording(sid).catch((e) => {
          frontendLog.warn("RecordingView", "stopRecording on unmount failed", {
            error: e,
            fields: { session_id: sid },
          });
        });
      }
      previewLeaseRef.current?.release();
      previewLeaseRef.current = null;
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive steps before capture starts.
  useEffect(() => {
    let cancelled = false;
    parseStory(storySource)
      .then((result) => {
        if (cancelled || !result.ast) return;
        const derived = result.ast.scenes.flatMap((scene) =>
          scene.commands.map((command, index) => ({
            index,
            status: "pending" as const,
            verb: command.verb,
          })),
        );
        setSteps(derived);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [setSteps, storySource]);

  // Surface non-fatal mic degradation events.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<string>("audio://disconnected", (event) => {
      const msg =
        typeof event.payload === "string"
          ? event.payload
          : "Microphone disconnected — continuing video-only.";
      toast.warning(msg);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Elapsed timer.
  useEffect(() => {
    if (status !== "recording") return;
    const handle = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Date.now() - startedAtRef.current);
      }
    }, 250);
    return () => window.clearInterval(handle);
  }, [status, setElapsed]);

  // Heartbeat watchdog. Runs only while recording; flips `desynced`
  // when >5s since the last heartbeat tick. A fresh `heartbeat` event
  // clears it (handled in the dispatch switch above).
  useEffect(() => {
    if (status !== "recording") return;
    const handle = window.setInterval(() => {
      const last = lastHeartbeatRef.current;
      if (last == null) return;
      if (Date.now() - last > 5000) {
        setDesynced(true);
      }
    }, 1000);
    return () => window.clearInterval(handle);
  }, [status]);

  const finalizeRecording = (ownerSessionId: string, result: RecordingCompletedResult) => {
    if (
      !canFinalizeOwnedRecording({
        ownerSessionId,
        activeSessionId: sessionRef.current ? sessionKey(sessionRef.current) : null,
        completedSessionId: completedSessionRef.current,
      })
    ) {
      return;
    }
    completedSessionRef.current = ownerSessionId;
    cleanupSessionResources(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("completed");
    setOutputPath(result.output_path);
    if (projectId) {
      publishCompletedRecording(queryClient, projectId, {
        path: result.output_path,
        captured_at: Date.now(),
        duration_ms: result.duration_ms,
        width: "output_width" in result ? (result.output_width ?? null) : null,
        height: "output_height" in result ? (result.output_height ?? null) : null,
        ...("version" in result && result.version === 3
          ? {
              version: 3 as const,
              width: 1920,
              height: 1080,
              bundle_path: result.bundle_path,
              master_path: result.master_path,
              proxy_path: result.proxy_path,
              cadence_evidence_path: `${result.bundle_path}/evidence/cadence.json`,
              quality_evidence_path: `${result.bundle_path}/evidence/runtime-quality.json`,
              frame_ledger_path: `${result.bundle_path}/evidence/frame-ledger.jsonl`,
              exact_source_fps: result.cadence_evidence.source_fps,
              source_frame_count: result.cadence_evidence.source_presentations,
              certification_profile: result.certification_profile,
              recording_mode: result.recording_mode,
              guarantee_boundary: result.guarantee_boundary,
              source_scope_verified: true,
              quality_verdict: result.quality_evidence.verdict,
            }
          : {}),
      });
    }
    if (!("status" in result) && result.cadence_warning) {
      const cadence =
        typeof result.actual_capture_fps === "number" && typeof result.requested_fps === "number"
          ? `${result.actual_capture_fps} / ${result.requested_fps} fps`
          : null;
      toast.warning("Recording complete with low cadence", {
        description: [result.cadence_warning_message, cadence, result.output_path]
          .filter(Boolean)
          .join(" · "),
      });
    } else {
      toast.success("Recording complete", { description: result.output_path });
    }
    if (autoOpenPostProduction && projectId) {
      navigate(`/post-production/${projectId}`, { replace: true });
    }
    acknowledgeTerminalSession(ownerSessionId);
  };

  const failRecording = (ownerSessionId: string, message: string) => {
    if (!ownsActiveSession(ownerSessionId) || completedSessionRef.current === ownerSessionId)
      return;
    cleanupSessionResources(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("failed");
    setError(message);
    toast.error(`Recording failed: ${message}`);
    acknowledgeTerminalSession(ownerSessionId);
  };

  const failQualityRecording = (
    ownerSessionId: string,
    result: Extract<RecordingStopResult, { status: "quality_failed" }>,
  ) => {
    if (completedSessionRef.current === ownerSessionId) return;
    completedSessionRef.current = ownerSessionId;
    cleanupSessionResources(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("quality_failed");
    setQualityFailure(result);
    setOutputPath(result.diagnostic_bundle_path);
    const message = result.cadence_evidence.failure_codes
      .concat(result.quality_evidence.failure_codes)
      .join(", ");
    const label = result.version === 3 && result.recording_mode === "uncertified_development"
      ? "Development verification failed"
      : "Strict verification failed";
    setError(message || label);
    toast.error(label, {
      description: message || result.diagnostic_bundle_path || undefined,
    });
    acknowledgeTerminalSession(ownerSessionId);
  };

  const dispatch = (ownerSessionId: string, event: RecordingEvent) => {
    if (!ownsActiveSession(ownerSessionId)) return;
    switch (event.type) {
      case "completed":
        finalizeRecording(ownerSessionId, event.result);
        break;
      case "preflight":
        setPreflight(event.result);
        if (!recordingPreflightEligible(event.result)) {
          setError(
            event.result.version === 3
              ? recordingV3FailureSummary(event.result)
              : `Strict preflight blocked: ${event.result.failure_codes.join(", ")}`,
          );
        }
        break;
      case "readiness":
        setReadiness(event.state);
        break;
      case "live-evidence":
        setLiveEvidence(event.evidence);
        break;
      case "verifying":
        setStatus("verifying");
        setVerificationProgress(Math.max(0, Math.min(1, event.progress)));
        break;
      case "quality-failed": {
        failQualityRecording(ownerSessionId, event.result);
        break;
      }
      case "failed":
        failRecording(ownerSessionId, event.message);
        break;
      case "audio-unavailable":
        // Mic negotiation failed; recording continues video-only.
        toast.error(`Audio unavailable: ${event.reason}`);
        setAudioUnavailable(true);
        break;
      case "heartbeat":
        // Host liveness signal; watchdog clears any desync banner.
        lastHeartbeatRef.current = Date.now();
        setDesynced(false);
        break;
      default:
        break;
    }
  };
  v3ReattachHandlersRef.current = {
    dispatch,
    fail: failRecording,
    failQuality: failQualityRecording,
    finalize: finalizeRecording,
  };

  useEffect(() => {
    let cancelled = false;
    void queryRecordingV3Sessions(projectFolder)
      .then((snapshots) => {
        if (cancelled || sessionRef.current || snapshots.length === 0) return;
        const snapshot = snapshots[0];
        const ownerSessionId = snapshot.id;
        const session = { id: ownerSessionId } satisfies RecordingSessionId;
        recordingContractVersionRef.current = 3;
        sessionRef.current = session;
        completedSessionRef.current = null;
        startedAtRef.current = snapshot.started_at_ms;
        pausedAtRef.current = snapshot.lifecycle === "paused" ? Date.now() : null;
        lastHeartbeatRef.current = Date.now();
        const recorder = useRecorderStore.getState();
        recorder.setSession(ownerSessionId);
        recorder.setPreflight(snapshot.preflight);
        recorder.setElapsed(Math.max(0, Date.now() - snapshot.started_at_ms));
        const handlers = v3ReattachHandlersRef.current;
        if (!handlers) return;

        if (snapshot.result?.status === "completed") {
          handlers.finalize(ownerSessionId, snapshot.result);
          return;
        }
        if (snapshot.result?.status === "quality_failed") {
          handlers.failQuality(ownerSessionId, snapshot.result);
          return;
        }
        if (snapshot.failure_message) {
          handlers.fail(ownerSessionId, snapshot.failure_message);
          return;
        }

        recorder.setStatus(
          snapshot.lifecycle === "paused"
            ? "paused"
            : snapshot.lifecycle === "stopping"
              ? "stopping"
              : "recording",
        );
        void reattachRecordingV3(ownerSessionId, (event) =>
          v3ReattachHandlersRef.current?.dispatch(ownerSessionId, event),
        ).catch((reattachError) => {
          if (!cancelled) {
            v3ReattachHandlersRef.current?.fail(ownerSessionId, formatIpcError(reattachError));
          }
        });
      })
      .catch((queryError) => {
        frontendLog.warn("RecordingView", "Recording V3 session query failed", {
          error: queryError,
          fields: { project_folder: projectFolder },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectFolder]);

  const handleRecord = async () => {
    // Double-start guard. Synchronous status flip before any await so a
    // 10 ms double-click cannot enter this function twice.
    if (startInFlightRef.current || useRecorderStore.getState().status !== "idle") return;
    startInFlightRef.current = true;
    setStatus("starting");
    // Fresh per-session UX state for the audio/heartbeat badges.
    setAudioUnavailable(false);
    setDesynced(false);
    lastHeartbeatRef.current = null;
    if (permission !== "granted") {
      setStatus("idle");
      startInFlightRef.current = false;
      return;
    }
    if (selectedDisplay == null) {
      toast.error("Pick a Target before recording.");
      setStatus("idle");
      startInFlightRef.current = false;
      return;
    }
    startedAtRef.current = Date.now();
    pausedAtRef.current = null;
    automationOwnsStopRef.current = false;
    automationFailedOrdinalRef.current = null;
    const display = selectedDisplayInfo;
    // Seed with display dims; browser stories overwrite this with the
    // author-preview webContents viewport.
    let width = display?.width_px ?? 1920;
    let height = display?.height_px ?? 1080;
    try {
      const pacingProfile = DEFAULT_RECORDING_PACING;
      const recordingDisplay = display ? { x: display.x, y: display.y } : null;
      const recordingViewport = storyHasBrowser ? storyViewport : null;
      // Output knobs from useOutputPrefsStore (one-shot read).
      const {
        activePreset,
        recordingDeliveryPolicy,
        recordingV3DevelopmentMode,
        recordingKnobs: prefs,
      } = useOutputPrefsStore.getState();
      const strictV3 = recordingDeliveryPolicy === "strict";
      const developmentV3 = recordingV3DevelopmentMode;
      const recordingV3 = strictV3 || developmentV3;
      if (recordingV3 && !storyHasBrowser) {
        throw new Error(recordingV3FailureMessage("target_unsupported"));
      }
      if (recordingV3 && audioDeviceId) {
        throw new Error(recordingV3FailureMessage("unsupported_audio_role"));
      }
      if (recordingV3 && (storyViewport.width !== 960 || storyViewport.height !== 540)) {
        throw new Error(
          `${recordingV3FailureMessage("contract_mismatch")} Recording V3 requires a 960×540 browser viewport.`,
        );
      }
      if (storyHasBrowser) {
        frontendLog.info("RecordingView", "browser recording viewport plan", {
          fields: {
            selected_display_id: display ? displayId(display) : null,
            selected_display_name: display?.name ?? null,
            selected_display_scale: display?.scale_factor ?? null,
            requested_viewport_width: storyViewport.width,
            requested_viewport_height: storyViewport.height,
            effective_viewport_width: storyViewport.width,
            effective_viewport_height: storyViewport.height,
            target_kind: "author_preview",
          },
        });
      }
      const shouldAutoFollow = storyHasBrowser;
      let recordingTarget: CaptureTarget = {
        kind: "display" as const,
        display_id: selectedDisplay,
      };
      let frameCrop: {
        x: number;
        y: number;
        w: number;
        h: number;
        basis_w?: number | null;
        basis_h?: number | null;
        scale_hint?: number | null;
      } | null = null;
      let browserStreamId: string | null = null;
      if (shouldAutoFollow) {
        const appUrl = storyInitialUrl;
        if (!appUrl) throw new Error("Browser story is missing a valid meta.app URL");
        releasePreviewLease();
        const lease = await acquireRecordingPreview({
          appUrl,
          viewport: recordingViewport ?? storyViewport,
          fps: recordingV3 ? 60 : prefs.fps,
          placement: recordingDisplay,
          reason: "recording-start",
        });
        previewLeaseRef.current = lease;
        browserStreamId = lease.streamId;
        const authorViewport = recordingViewport ?? storyViewport;
        const targetPlan = authorPreviewRecordingPlan(browserStreamId, authorViewport);
        recordingTarget = targetPlan.target;
        width = targetPlan.width;
        height = targetPlan.height;
        frameCrop = targetPlan.frameCrop;
        frontendLog.info("RecordingView", "browser author-preview recording target", {
          fields: {
            stream_id: browserStreamId,
            viewport_width: targetPlan.width,
            viewport_height: targetPlan.height,
            target_kind: recordingTarget.kind,
          },
        });
        toast.info("Recording browser preview content");
      }
      let ownerSessionId: string | null = null;
      const pendingRecordingEvents: RecordingEvent[] = [];
      const recordingArgs: StartRecordingArgs = {
        project_folder: projectFolder,
        target: recordingTarget,
        width,
        height,
        fps: recordingV3 ? 60 : prefs.fps,
        contract_version: recordingV3 ? 3 : 2,
        intent: developmentV3 ? "development" : strictV3 ? "strict" : undefined,
        delivery_policy: developmentV3 ? "development" : recordingDeliveryPolicy,
        capture_contract: recordingV3 ? recordingV3CaptureContract(width, height) : undefined,
        audio_device_id: recordingV3 ? undefined : (audioDeviceId ?? undefined),
        include_cursor: recordingV3 ? false : includeCursor,
        output_resolution: recordingOutputResolutionForStart(prefs, activePreset),
        fit_mode: prefs.fit,
        pad_color: prefs.pad,
        quality_preset: prefs.quality,
        scale_algo: "lanczos",
        frame_crop: frameCrop,
      };
      if (recordingV3) {
        const capability = await probeRecordingV3Capability(recordingArgs);
        setPreflight(capability);
        if (!recordingPreflightEligible(capability, developmentV3)) {
          throw new Error(recordingV3FailureSummary(capability));
        }
      }
      const id = await startRecording(recordingArgs, (event) => {
        if (ownerSessionId) dispatch(ownerSessionId, event);
        else pendingRecordingEvents.push(event);
      });
      ownerSessionId = sessionKey(id);
      recordingContractVersionRef.current = recordingV3 ? 3 : 2;
      sessionRef.current = id;
      completedSessionRef.current = null;
      previewSessionRef.current = ownerSessionId;
      setSession(ownerSessionId);
      for (const event of pendingRecordingEvents) dispatch(ownerSessionId, event);
      if (!ownsActiveSession(ownerSessionId)) {
        startInFlightRef.current = false;
        return;
      }
      // Transition starting -> recording only after the host has
      // confirmed the session. If we error out above, the catch arm
      // resets to "idle" so the Start button re-enables.
      setStatus("recording");
      startInFlightRef.current = false;

      automationOwnsStopRef.current = true;
      automationSessionRef.current = ownerSessionId;
      launchAutomation(
        {
          storySource,
          projectFolder,
          streamId: browserStreamId,
          chromeHiding,
          recordingDisplay,
          recordingViewport,
          pacingProfile,
          recordingSessionId: ownerSessionId,
        },
        (evt) => dispatchAutomation(ownerSessionId, evt),
        (ch) => {
          if (ownsActiveSession(ownerSessionId)) automationChannelRef.current = ch;
          else ch.onmessage = null;
        },
      )
        .then((outcome) => {
          if (!ownsActiveSession(ownerSessionId)) return;
          if (
            outcome.story.failed > 0 &&
            outcome.story.failed_ordinal != null &&
            automationFailedOrdinalRef.current !== outcome.story.failed_ordinal
          ) {
            automationFailedOrdinalRef.current = outcome.story.failed_ordinal;
            advanceStep(outcome.story.failed_ordinal - 1, "failed");
            toast.warning(
              `Story finished with ${outcome.story.failed} failure(s) at step ${outcome.story.failed_ordinal}`,
            );
          }
          automationOwnsStopRef.current = false;
          if (outcome.recording.status === "finalized") {
            finalizeRecording(ownerSessionId, outcome.recording.result);
          } else if (outcome.recording.status === "quality_failed") {
            failQualityRecording(ownerSessionId, outcome.recording.result);
          } else if (
            outcome.recording.status === "ready_to_finalize" ||
            outcome.recording.status === "not_requested"
          ) {
            void handleStop(ownerSessionId);
          }
        })
        .catch((e) => {
          if (!ownsActiveSession(ownerSessionId)) return;
          automationOwnsStopRef.current = false;
          const msg = formatIpcError(e);
          toast.error(`Automation failed: ${msg}`);
          setError(msg);
          void handleStop(ownerSessionId);
        });
    } catch (e) {
      releasePreviewLease();
      setError(formatIpcError(e));
      // Error path resets to idle so the Start button re-enables; the
      // toast + error banner still surface the failure to the user.
      setStatus("idle");
      startInFlightRef.current = false;
      toast.error(`Recording failed to start: ${formatIpcError(e)}`);
    }
  };

  // Map automation events onto the step rail.
  const dispatchAutomation = (ownerSessionId: string, evt: ExecutorEvent) => {
    if (!ownsActiveSession(ownerSessionId)) return;
    // Recording path never emits run_paused or step_frame_captured
    // (capture_frames=false, stop_after_ordinal=None). Defaulted cases stay
    // no-op; the simulator consumes those variants via simulatorStore,
    // not this switch.
    switch (evt.type) {
      case "step_started":
        advanceStep(evt.ordinal - 1, "running");
        break;
      case "step_succeeded":
        advanceStep(evt.ordinal - 1, "succeeded");
        pushCursor({ x: evt.cursor_x, y: evt.cursor_y, t: Date.now() });
        break;
      case "step_failed": {
        automationFailedOrdinalRef.current = evt.ordinal;
        advanceStep(evt.ordinal - 1, "failed");
        // Detect the PrimaryMissNoHeal error by substring-matching the
        // locked copy. On a match, pipe the verb excerpt + ordinal into
        // the recorder store so the HUD renders the destructive block +
        // "Open in Simulator" action, and fire the Sonner destructive
        // toast carrying the same copy with the action slot.
        const miss = parsePrimaryMiss(evt.error_message);
        if (miss) {
          setPrimaryMiss({
            ordinal: evt.ordinal,
            verbExcerpt: miss.verbExcerpt,
          });
          const body = RECORD_PATH_MISS_BODY.replace("{N}", String(evt.ordinal));
          const targetOrdinal = evt.ordinal;
          const clampedProjectId = projectId;
          toast.error(`Step ${targetOrdinal}: ${miss.verbExcerpt} could not match any element.`, {
            description: body,
            duration: 12_000,
            action: clampedProjectId
              ? {
                  label: "Open in Simulator",
                  // User decides when to start the simulator — this
                  // action only routes into the Editor at the failed
                  // step.
                  onClick: () => {
                    window.location.hash = `#/editor/${clampedProjectId}?step=${targetOrdinal}`;
                  },
                }
              : undefined,
          });
        } else {
          toast.error(`Step ${evt.ordinal} failed: ${evt.error_message}`);
        }
        break;
      }
      case "story_ended":
        if (evt.status.failed > 0) {
          toast.warning(`Story finished with ${evt.status.failed} failure(s)`);
        }
        if (!automationOwnsStopRef.current) {
          // Stop capture after the DSL finishes when the host isn't already
          // attached to the recording session.
          window.setTimeout(() => {
            void handleStop(ownerSessionId);
          }, 500);
        }
        break;
      default:
        break;
    }
  };

  const handleStop = async (expectedSessionId?: string) => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    const ownerSessionId = sessionKey(session);
    if (expectedSessionId && expectedSessionId !== ownerSessionId) return;
    if (stopInFlightRef.current === ownerSessionId) return;
    stopInFlightRef.current = ownerSessionId;
    setStatus("stopping");
    try {
      const result = await stopRecording(session, (event) => dispatch(ownerSessionId, event));
      if ("status" in result && result.status === "quality_failed") {
        failQualityRecording(ownerSessionId, result);
      } else {
        finalizeRecording(ownerSessionId, result);
      }
    } catch (e) {
      if (!ownsActiveSession(ownerSessionId)) return;
      if (isNotFoundIpcError(e) && automationOwnsStopRef.current) return;
      cleanupSessionResources(ownerSessionId);
      sessionRef.current = null;
      startedAtRef.current = null;
      pausedAtRef.current = null;
      setSession(null);
      const message = formatIpcError(e);
      setStatus("failed");
      setError(message);
      toast.error(`Stop failed: ${message}`);
    } finally {
      if (stopInFlightRef.current === ownerSessionId) stopInFlightRef.current = null;
    }
  };

  // "Force stop" escape hatch surfaced when the heartbeat watchdog
  // declares a desync. Always resets local state to idle regardless of
  // IPC outcome — NotFound is treated as success (session already gone).
  const forceStop = async () => {
    const sid = sessionRef.current;
    const ownerSessionId = sid ? sessionKey(sid) : null;
    sessionRef.current = null;
    setSession(null);
    setDesynced(false);
    try {
      if (sid) {
        await stopRecording(sid);
      }
    } catch (e) {
      if (!isNotFoundIpcError(e)) {
        frontendLog.warn("RecordingView", "forceStop: stopRecording error", {
          error: e,
          fields: { ipc_error: formatIpcError(e) },
        });
      }
    }
    startedAtRef.current = null;
    pausedAtRef.current = null;
    if (ownerSessionId) cleanupSessionResources(ownerSessionId);
    else releasePreviewLease();
    setStatus("idle");
    setElapsed(0);
  };

  const handlePause = async () => {
    if (!sessionRef.current || status !== "recording") return;
    try {
      const acknowledgement = await pauseRecording(sessionRef.current);
      if (acknowledgement.status !== "paused") throw new Error("recording session not found");
      pausedAtRef.current = Date.now();
      setStatus("paused");
    } catch (e) {
      const message = formatIpcError(e);
      setError(message);
      toast.error(`Pause failed: ${message}`);
    }
  };

  const handleResume = async () => {
    if (!sessionRef.current || status !== "paused") return;
    try {
      const acknowledgement = await resumeRecording(sessionRef.current);
      if (acknowledgement.status !== "recording") throw new Error("recording session not found");
      if (startedAtRef.current && pausedAtRef.current) {
        startedAtRef.current += Date.now() - pausedAtRef.current;
      }
      pausedAtRef.current = null;
      setStatus("recording");
    } catch (e) {
      const message = formatIpcError(e);
      setError(message);
      toast.error(`Resume failed: ${message}`);
    }
  };

  handleRecordRef.current = handleRecord;
  handleStopRef.current = handleStop;

  // ⌘R / Ctrl+R toggles recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        if (status === "idle") void handleRecordRef.current?.();
        else if (status === "recording" || status === "paused") {
          void handleStopRef.current?.();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  const canRecord = permission === "granted" && captureTarget != null;
  // Display-only code path for `handleRecord`.
  const canRecordDisplay = canRecord && selectedDisplay != null;
  const targetControlsLocked =
    permission !== "granted" ||
    status === "recording" ||
    status === "paused" ||
    status === "stopping" ||
    status === "verifying";
  const permissionDenied = permission === "denied";
  const permissionPending = permission === "undetermined";
  const navigationLocked =
    status === "recording" ||
    status === "paused" ||
    status === "stopping" ||
    status === "verifying";
  const hasValidRecording = existingRecordingCount > 0 || status === "completed";
  const workflowSnapshot: ProjectWorkflowSnapshot = {
    storyValid: steps.length > 0,
    previewState: "complete",
    hasValidRecording,
    editState: hasValidRecording ? "review" : "unavailable",
    exportReady: hasValidRecording,
    exportBlockedReason: hasValidRecording
      ? undefined
      : "Complete a valid recording before exporting.",
  };
  const primaryAction = (() => {
    if (status === "idle") {
      return {
        label: "Start recording",
        onClick: () => void handleRecord(),
        disabled: !canRecordDisplay || isOutputBlocked || strictUnavailableReason !== null,
        title: !canRecordDisplay
          ? "Resolve permissions and select a capture target"
          : (strictUnavailableReason ?? undefined),
      };
    }
    if (status === "recording") {
      return {
        label: "Stop",
        ariaLabel: "Stop recording",
        onClick: () => void handleStop(),
        tone: "danger" as const,
      };
    }
    if (status === "paused") {
      return { label: "Resume", onClick: () => void handleResume() };
    }
    if (status === "completed") {
      return {
        label: "Review recording",
        onClick: () => projectId && navigate(`/post-production/${projectId}`),
        tone: "success" as const,
      };
    }
    if (status === "failed" || status === "quality_failed") {
      return {
        label: "Retry recording",
        onClick: () => {
          resetTake();
          applyRecorderDefaults();
        },
      };
    }
    return undefined;
  })();

  return (
    <main id="main-content" className="relative flex h-full flex-col bg-[var(--color-bg-primary)]">
      <ProjectStageHeader
        projectId={projectId ?? ""}
        projectName={projectName}
        workflowLabel={`${recordingV3DevelopmentMode ? "Dev V3" : recordingDeliveryPolicy === "strict" ? "Strict" : "Standard"} recording`}
        currentStage="record"
        snapshot={workflowSnapshot}
        navigationLocked={navigationLocked}
        primaryAction={primaryAction}
      />

      {status === "recording" ||
      status === "paused" ||
      status === "verifying" ||
      audioUnavailable ? (
        <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4">
          {status === "recording" || status === "paused" ? (
            <LiveRecordingBadge paused={status === "paused"} reduceMotion={!!reduceMotion} />
          ) : null}
          {status === "verifying" ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent)]">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              Verifying {Math.round((verificationProgress ?? 0) * 100)}%
            </span>
          ) : null}
          {audioUnavailable ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-warning)]"
            >
              <AlertTriangle size={12} aria-hidden="true" />
              Audio unavailable — recording video only
            </span>
          ) : null}
          {sessionId ? (
            <span className="ml-auto font-mono text-[11px] text-[var(--color-fg-muted)]">
              session · {sessionId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ─── Permission banner (inline, not modal) ─── */}
      {permissionDenied || permissionPending ? (
        <PermissionBanner
          report={permissionReport}
          onOpenSettings={async () => {
            try {
              const report = await requestScreenCaptureAccess();
              setPermissionReport(report);
              if (report.state === "granted") {
                try {
                  await loadCaptureTargets();
                } catch (e) {
                  toast.error(`loadCaptureTargets failed: ${formatIpcError(e)}`);
                }
              }
            } catch {
              /* non-fatal; still open Settings */
            }
            openScreenCapturePrefs().catch(() => {});
            // Open the guided dialog for first-time onboarding.
            setTccOpen(true);
          }}
          onRelaunch={() => {
            relaunchApp().catch(() => {});
          }}
          onRecheck={async () => {
            const next = await checkScreenCapturePermission();
            setPermissionReport(next);
            if (next.state === "granted") {
              try {
                await loadCaptureTargets();
              } catch (e) {
                toast.error(`loadCaptureTargets failed: ${formatIpcError(e)}`);
              }
              toast.success("Screen recording permission granted");
            } else {
              toast.message("Permission still needed", {
                description: `After granting in System Settings, relaunch ${next.appName} so macOS picks up the change.`,
              });
            }
          }}
          onBypass={
            permissionReport.debugBypassAllowed
              ? async () => {
                  setPermissionReport({
                    ...permissionReport,
                    state: "granted",
                    reason: "Debug TCC bypass enabled",
                  });
                  setTccOpen(false);
                  try {
                    await loadCaptureTargets();
                    toast.success("Debug permission bypassed");
                  } catch (e) {
                    toast.error(`Could not load capture targets: ${formatIpcError(e)}`);
                  }
                }
              : undefined
          }
        />
      ) : null}

      {(recordingDeliveryPolicy === "strict" || recordingV3DevelopmentMode) && preflight ? (
        <div
          role="status"
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-xs ${
            recordingPreflightEligible(preflight, recordingV3DevelopmentMode)
              ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10"
              : "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {recordingPreflightEligible(preflight, recordingV3DevelopmentMode) ? (
              <CheckCircle2 size={13} className="text-[var(--color-success)]" aria-hidden="true" />
            ) : (
              <AlertTriangle size={13} className="text-[var(--color-danger)]" aria-hidden="true" />
            )}
            <span className="font-medium text-[var(--color-fg-primary)]">
              {recordingV3DevelopmentMode
                ? preflight.version === 3 && preflight.development_eligible
                  ? "Dev V3 preflight passed"
                  : "Dev V3 preflight blocked"
                : preflight.strict_eligible
                  ? "Strict preflight passed"
                  : "Strict preflight blocked"}
            </span>
            <span className="text-[var(--color-fg-secondary)]">
              {preflight.backend_id} {preflight.backend_version}
              {preflight.version === 3
                ? preflight.matched_profile
                  ? ` · ${preflight.matched_profile.profile_id}`
                  : " · uncertified"
                : preflight.certification
                  ? ` · ${preflight.certification.id}`
                  : " · uncertified"}
            </span>
          </div>
          <span className="font-mono text-[11px] text-[var(--color-fg-secondary)]">
            {liveEvidence
              ? `${
                  liveEvidence.version === 3
                    ? liveEvidence.native_commits
                    : liveEvidence.encoder_acked_frames
                }/${liveEvidence.expected_slots} committed`
              : preflight.version === 3 && preflight.failure_codes.length > 0
                ? recordingV3FailureSummary(preflight)
                : preflight.failure_codes.join(", ") || "60/1 · 1920×1080"}
          </span>
        </div>
      ) : null}

      {recordingV3DevelopmentMode ? (
        <div className="flex items-center gap-2 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-4 py-2 text-xs font-medium text-[var(--color-warning)]">
          <AlertTriangle size={13} aria-hidden="true" />
          Uncertified Development — not a Strict-certified recording
        </div>
      ) : null}

      {qualityFailure ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-2 text-xs">
          <div className="min-w-0">
            <div className="font-medium text-[var(--color-fg-primary)]">
              {qualityFailure.version === 3 &&
              qualityFailure.recording_mode === "uncertified_development"
                ? "Development take was not published"
                : "Strict take was not published"}
            </div>
            <div className="truncate text-[var(--color-fg-secondary)]">
              {[
                ...qualityFailure.cadence_evidence.failure_codes,
                ...qualityFailure.quality_evidence.failure_codes,
              ].join(", ") || "Verification failed"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resetTake()}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)]"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={!qualityFailure.diagnostic_bundle_path}
              onClick={() => {
                if (qualityFailure.diagnostic_bundle_path) {
                  void openRecordingDiagnosticBundle(qualityFailure.diagnostic_bundle_path);
                }
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] disabled:opacity-40"
            >
              Open diagnostics
            </button>
            <button
              type="button"
              disabled={!qualityFailure.diagnostic_bundle_path}
              onClick={() => {
                const bundlePath = qualityFailure.diagnostic_bundle_path;
                if (!bundlePath) return;
                void deleteFailedRecordingBundle(projectFolder, bundlePath)
                  .then(() => {
                    resetTake();
                    toast.success("Failed take deleted");
                  })
                  .catch((deleteError) => {
                    toast.error("Could not delete failed take", {
                      description: formatIpcError(deleteError),
                    });
                  });
              }}
              className="rounded-[var(--radius-sm)] bg-[var(--color-danger)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {/* ─── Stage Manager warning (inline, dismissible) ─── */}
      {stageManagerWarning ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-4 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-[var(--color-warning)]">
            <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
            <span className="font-medium text-[var(--color-fg-primary)]">
              Stage Manager is on — window capture will black out if you switch stages.
            </span>
            <span className="text-[var(--color-fg-secondary)]">
              Turn it off in Control Centre for reliable browser recording.
            </span>
          </div>
          <button
            onClick={() => setStageManagerWarning(false)}
            className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)]"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Heartbeat-watchdog banner. Renders only while recording and the
          host has gone >5s without a heartbeat. */}
      {desynced && (status === "recording" || status === "paused") ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2 text-[var(--color-danger)]">
            <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
            <span className="font-medium text-[var(--color-fg-primary)]">
              Recording state out of sync
            </span>
            <span className="text-[var(--color-fg-secondary)]">
              No heartbeat from the recorder for 5s. Force stop to recover.
            </span>
          </div>
          <button
            onClick={() => void forceStop()}
            className="rounded-[var(--radius-sm)] bg-[var(--color-danger)] px-2.5 py-1 text-[11px] font-medium text-white transition-[filter] duration-150 hover:brightness-110"
          >
            Force stop
          </button>
        </div>
      ) : null}

      {/* ─── Main workspace: 3-zone ─── */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
        {/* LEFT: preview/stage */}
        <section className="flex min-h-0 flex-col border-r border-[var(--color-border-subtle)]">
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <PreviewStage
              status={status}
              elapsedMs={elapsedMs}
              currentStepLabel={currentStepEntry?.verb ?? null}
              currentStepIndex={currentStep}
              totalSteps={steps.length}
              error={error}
              outputPath={outputPath}
              reduceMotion={!!reduceMotion}
            />
          </div>

          {/* Step rail — horizontal chips */}
          <div className="shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3">
            <StepRail steps={steps} currentStep={currentStep} completedSteps={completedSteps} />
          </div>

          {/* Primary action strip */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3">
            <div className="text-[11px] text-[var(--color-fg-muted)]">
              {status === "idle" && strictUnavailableReason ? (
                <span className="text-[var(--color-danger)]">{strictUnavailableReason}</span>
              ) : status === "idle" && canRecord ? (
                <span>Ready · {steps.length} steps</span>
              ) : status === "idle" && !canRecord ? (
                <span>Resolve permissions to record</span>
              ) : status === "recording" ? (
                <span>Recording in progress</span>
              ) : status === "paused" ? (
                <span>Recording paused</span>
              ) : status === "verifying" ? (
                <span>Verifying exact cadence and master hashes</span>
              ) : status === "completed" ? (
                <span className="text-[var(--color-success)]">Recording complete</span>
              ) : status === "quality_failed" ? (
                <span className="text-[var(--color-danger)]">Strict verification failed</span>
              ) : status === "failed" ? (
                <span className="text-[var(--color-danger)]">Recording failed</span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {status === "idle" && (
                <OutputSummaryBadge
                  onActivate={() => {
                    videoOutputSectionRef.current?.scrollIntoView({
                      behavior: reduceMotion ? "auto" : "smooth",
                      block: "center",
                    });
                  }}
                />
              )}
              {status === "recording" && (
                <button
                  onClick={handlePause}
                  aria-label="Pause recording"
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] transition-[transform,background-color] duration-150 hover:bg-[var(--color-surface-300)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                >
                  <Pause size={13} aria-hidden="true" />
                  Pause
                </button>
              )}
              {status === "paused" && (
                <button
                  onClick={() => void handleStop()}
                  aria-label="Stop recording"
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-danger)]/50 bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] transition-[transform,background-color] duration-150 hover:bg-[var(--color-danger)]/10 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                >
                  <StopIcon size={13} aria-hidden="true" />
                  Stop
                </button>
              )}
              {status === "completed" && (
                <>
                  <button
                    onClick={() => projectId && navigate(`/editor/${projectId}`)}
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-200)]"
                  >
                    Back to Author
                  </button>
                  <button
                    aria-label="New take"
                    onClick={() => {
                      resetTake();
                      applyRecorderDefaults();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs text-[var(--color-fg-primary)] hover:bg-[var(--color-surface-300)]"
                  >
                    Record another take
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT: settings rail */}
        <aside className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden bg-[var(--color-surface-100)] px-4 py-4">
          <section aria-labelledby="recorder-readiness-title">
            <div
              id="recorder-readiness-title"
              className="text-[11px] font-semibold text-[var(--color-fg-primary)]"
            >
              Readiness
            </div>
            <div className="mt-2 grid gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] p-3 text-[12px]">
              <SettingsRow
                k="Permission"
                v={permission === "granted" ? "Ready" : "Needs attention"}
              />
              <SettingsRow k="Target" v={captureTarget ? "Selected" : "Choose target"} />
              <SettingsRow k="Audio" v={audioDeviceId ? "Enabled" : "Video only"} />
              <SettingsRow k="Output" v={isOutputBlocked ? "Needs attention" : "Ready"} />
              {recordingDeliveryPolicy === "strict" || recordingV3DevelopmentMode ? (
                <SettingsRow
                  k={recordingV3DevelopmentMode ? "Dev V3" : "Strict"}
                  v={strictUnavailableReason ? "Blocked" : "Ready to probe"}
                />
              ) : null}
            </div>
          </section>

          <details className="group rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
            <summary className="cursor-pointer list-none px-3 py-2.5 text-[11px] font-semibold text-[var(--color-fg-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">
              Advanced settings
            </summary>
            <div className="flex flex-col gap-4 border-t border-[var(--color-border-subtle)] px-3 py-3">
              <SettingsGroup label="Source" icon={<Monitor size={13} />}>
                <label
                  htmlFor="target-select"
                  className="mb-1.5 block text-xs text-[var(--color-fg-muted)]"
                >
                  Target
                </label>
                <TargetPicker
                  availableTargets={availableTargets}
                  value={captureTarget}
                  onValueChange={(t) => {
                    void setCaptureTarget(t);
                  }}
                  onRefresh={() => loadCaptureTargets()}
                  disabled={targetControlsLocked}
                />
              </SettingsGroup>

              <SettingsGroup label="Microphone" icon={<SettingsIcon size={13} />}>
                <label
                  htmlFor="audio-device-select"
                  className="mb-1.5 block text-xs text-[var(--color-fg-muted)]"
                >
                  Audio input
                </label>
                <AudioDevicePicker
                  value={audioDeviceId}
                  onValueChange={setAudioDeviceId}
                  disabled={
                    status === "recording" ||
                    status === "paused" ||
                    status === "stopping" ||
                    status === "verifying"
                  }
                />
                <p className="mt-1.5 text-[10px] text-[var(--color-fg-muted)]">
                  Default is off; choose "System default" to include voice-over. Resets every
                  recording.
                </p>
              </SettingsGroup>

              <SettingsGroup label="Quality" icon={<SettingsIcon size={13} />}>
                <dl className="space-y-1 text-xs">
                  <SettingsRow k="Resolution" v="1920×1080" />
                  <SettingsRow k="Frame rate" v="60 fps" />
                  <SettingsRow k="Codec" v="H.264" />
                </dl>
              </SettingsGroup>

              <SettingsGroup label="Options">
                <div className="space-y-2 text-xs">
                  {/* Real OS cursor toggle (non-sticky, defaults OFF). */}
                  <CursorToggle
                    checked={includeCursor}
                    onChange={setIncludeCursor}
                    disabled={
                      status === "recording" ||
                      status === "paused" ||
                      status === "stopping" ||
                      status === "verifying"
                    }
                  />
                  {/* Chrome-hiding toggle (non-sticky, defaults OFF). */}
                  <ChromeHidingToggle
                    checked={chromeHiding}
                    onChange={setChromeHiding}
                    browserPreset={browserPreset}
                    disabled={
                      status === "recording" ||
                      status === "paused" ||
                      status === "stopping" ||
                      status === "verifying"
                    }
                  />
                  <Toggle label="3s countdown" checked={useCountdown} onChange={setUseCountdown} />
                </div>
              </SettingsGroup>

              <VideoOutputSection
                ref={videoOutputSectionRef}
                disabled={
                  status === "recording" ||
                  status === "paused" ||
                  status === "stopping" ||
                  status === "verifying"
                }
                captureDims={selectedCaptureDims}
              />
            </div>
          </details>

          <div className="mt-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
              Project folder
            </div>
            <div className="mt-1 font-mono text-[10px] text-[var(--color-fg-secondary)]">
              {projectFolder.split("/").slice(-2).join("/")}
            </div>
          </div>
        </aside>
      </div>

      {/* Fallback modal for first-time permission grant (macOS requires app restart) */}
      <TccPrompt
        open={tccOpen}
        permission={permission}
        appName={permissionReport.appName}
        onDismiss={() => setTccOpen(false)}
      />
    </main>
  );
}

/* ─── Subcomponents ─── */

function LiveRecordingBadge({ paused, reduceMotion }: { paused: boolean; reduceMotion: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        paused
          ? "bg-[var(--color-warning)]/15 text-[var(--color-warning)]"
          : "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
      }`}
    >
      <motion.span
        className={`h-1.5 w-1.5 rounded-full ${
          paused ? "bg-[var(--color-warning)]" : "bg-[var(--color-danger)]"
        }`}
        animate={reduceMotion ? undefined : { opacity: [1, 0.35, 1] }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      {paused ? "Paused" : "Live"}
    </span>
  );
}

function PermissionBanner({
  report,
  onOpenSettings,
  onRelaunch,
  onRecheck,
  onBypass,
}: {
  report: ScreenCapturePermissionReport;
  onOpenSettings: () => void;
  onRelaunch: () => void;
  onRecheck: () => void;
  onBypass?: () => void;
}) {
  const isDenied = report.state === "denied";
  const identityError = report.devIdentityOk === false;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-4 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-[var(--color-warning)]">
        <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
        <span className="font-medium text-[var(--color-fg-primary)]">
          {identityError
            ? "Dev app identity is not configured."
            : isDenied
              ? "Screen recording permission denied."
              : "Screen recording permission needed."}
        </span>
        <span className="text-[var(--color-fg-secondary)]">
          {identityError
            ? `macOS sees ${report.bundleId ?? report.appName}; dev should appear as StoryCapture Dev.`
            : `Grant Screen Recording access to ${report.appName} in System Settings, then relaunch.`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onBypass ? (
          <button
            onClick={onBypass}
            title="Debug-only: skip the permission check and try to record anyway"
            className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)]"
          >
            Debug bypass
          </button>
        ) : null}
        <button
          onClick={onRecheck}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)]"
        >
          Recheck
        </button>
        <button
          onClick={onRelaunch}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)]"
        >
          Relaunch
        </button>
        <button
          onClick={onOpenSettings}
          className="rounded-[var(--radius-sm)] bg-[var(--color-accent-primary)] px-2.5 py-1 text-[11px] font-medium text-white transition-[filter] duration-150 hover:brightness-110"
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}

interface PreviewStageProps {
  status: RecorderStatus;
  elapsedMs: number;
  currentStepLabel: string | null;
  currentStepIndex: number;
  totalSteps: number;
  error: string | null;
  outputPath: string | null;
  reduceMotion: boolean;
}

function PreviewStage({
  status,
  elapsedMs,
  currentStepLabel,
  currentStepIndex,
  totalSteps,
  error,
  outputPath,
  reduceMotion,
}: PreviewStageProps) {
  return (
    <div className="relative flex aspect-video w-full max-w-5xl flex-col items-center justify-center overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)]">
      {/* Subtle grid texture */}
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(rgba(38,37,30,0.05)_1px,transparent_1px)] [background-size:18px_18px]" />

      <AnimatePresence mode="wait">
        {status === "idle" && (
          <motion.div
            key="idle"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="relative flex flex-col items-center text-center"
          >
            <div className="grid h-14 w-14 place-items-center rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
              <Monitor size={22} className="text-[var(--color-fg-muted)]" aria-hidden="true" />
            </div>
            <p className="mt-4 text-sm font-medium text-[var(--color-fg-primary)]">
              Ready to record
            </p>
            <p className="font-serif mt-1 max-w-xs text-xs leading-relaxed text-[var(--color-fg-secondary)]">
              {totalSteps > 0
                ? `${totalSteps} scripted steps will execute against the selected display.`
                : "Add scenes to your story to schedule a scripted run."}
            </p>
          </motion.div>
        )}

        {(status === "recording" || status === "paused" || status === "stopping") && (
          <motion.div
            key="recording"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="relative flex flex-col items-center text-center"
          >
            <div className="font-mono text-[clamp(2.5rem,7vw,4.5rem)] font-semibold tabular-nums tracking-[-0.04em] text-[var(--color-fg-primary)]">
              {formatTime(elapsedMs)}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
              <span>{status === "paused" ? "Paused" : "Recording"}</span>
              <span>/</span>
              <span>Step {Math.min(currentStepIndex + 1, totalSteps)}</span>
              <span>/</span>
              <span>{totalSteps}</span>
            </div>
            <p className="font-mono mt-2 max-w-md truncate text-xs text-[var(--color-fg-secondary)]">
              {currentStepLabel ?? "waiting…"}
            </p>
          </motion.div>
        )}

        {status === "verifying" && (
          <motion.div
            key="verifying"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            className="relative flex flex-col items-center text-center"
          >
            <Loader2
              size={30}
              className="animate-spin text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <p className="mt-4 text-sm font-medium text-[var(--color-fg-primary)]">
              Verifying lossless master
            </p>
            <p className="mt-1 text-xs text-[var(--color-fg-secondary)]">
              Checking every frame hash and exact 60/1 cadence before publishing.
            </p>
          </motion.div>
        )}

        {status === "completed" && (
          <motion.div
            key="completed"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex flex-col items-center text-center"
          >
            <div className="grid h-14 w-14 place-items-center rounded-full bg-[var(--color-success)]/15 text-[var(--color-success)]">
              <CheckCircle2 size={26} aria-hidden="true" />
            </div>
            <p className="mt-4 text-sm font-medium text-[var(--color-fg-primary)]">
              Recording complete
            </p>
            {outputPath && (
              <p className="font-mono mt-1 max-w-md truncate text-[11px] text-[var(--color-fg-secondary)]">
                {outputPath}
              </p>
            )}
          </motion.div>
        )}

        {(status === "failed" || status === "quality_failed") && error && (
          <motion.div
            key="failed"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            className="relative flex max-w-md flex-col items-center text-center"
          >
            <AlertTriangle size={26} className="text-[var(--color-danger)]" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-[var(--color-fg-primary)]">
              {status === "quality_failed" ? "Strict verification failed" : "Recording failed"}
            </p>
            <p className="font-mono mt-1 text-[11px] text-[var(--color-fg-secondary)]">{error}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface StepRailProps {
  steps: StepProgress[];
  currentStep: number;
  completedSteps: number;
}

function StepRail({ steps, currentStep, completedSteps }: StepRailProps) {
  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-[var(--color-fg-muted)]">
          No steps yet — add scenes to the story.
        </span>
      </div>
    );
  }

  const failedCount = steps.filter((s) => s.status === "failed").length;
  const activeIdx = Math.min(currentStep, steps.length - 1);
  const activeStep = steps[activeIdx];
  const activeRunning = activeStep?.status === "running";
  const activeFailed = activeStep?.status === "failed";
  const progressPct = Math.round((completedSteps / steps.length) * 100);

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1: focus — current step readout + counters */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${
              activeFailed
                ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                : activeRunning
                  ? "bg-[var(--color-accent-primary)]/15 text-[var(--color-accent-primary)]"
                  : "bg-[var(--color-surface-300)] text-[var(--color-fg-muted)]"
            }`}
          >
            {activeFailed ? (
              <AlertTriangle size={9} aria-hidden="true" />
            ) : activeRunning ? (
              <Loader2 size={9} className="animate-spin" aria-hidden="true" />
            ) : (
              <Circle size={7} aria-hidden="true" />
            )}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
            {String(activeIdx + 1).padStart(2, "0")}
            <span className="opacity-50">/{String(steps.length).padStart(2, "0")}</span>
          </span>
          <span className="min-w-0 truncate text-[11px] text-[var(--color-fg-primary)]">
            {activeStep?.verb ?? "—"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
          <span>
            <span className="text-[var(--color-success)]">{completedSteps}</span>
            <span className="mx-1 opacity-40">·</span>
            <span className={failedCount ? "text-[var(--color-danger)]" : ""}>
              {failedCount} failed
            </span>
          </span>
          <span className="font-mono tabular-nums text-[var(--color-fg-secondary)]">
            {progressPct}%
          </span>
        </div>
      </div>

      {/* Row 2: all-steps matrix — fixed height, no scroll.
          Auto-fit cells shrink to accommodate any step count. */}
      <div
        className="grid gap-[3px]"
        style={{
          gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        }}
      >
        {steps.map((step, i) => {
          const active = i === activeIdx;
          const done = step.status === "succeeded";
          const running = step.status === "running";
          const failed = step.status === "failed";
          const tone = failed
            ? "bg-[var(--color-danger)]"
            : done
              ? "bg-[var(--color-success)]"
              : running
                ? "bg-[var(--color-accent-primary)]"
                : "bg-[var(--color-surface-300)]";
          return (
            <motion.div
              key={i}
              layout
              title={`${i + 1}. ${step.verb}${
                failed ? " — failed" : done ? " — done" : running ? " — running" : ""
              }`}
              className="group relative h-2 min-w-0"
              initial={false}
            >
              <span
                className={`block h-full w-full rounded-[2px] transition-[opacity,transform] duration-200 ${tone} ${
                  done || failed || running ? "opacity-90" : "opacity-50"
                } ${running ? "animate-pulse" : ""}`}
              />
              {active && (
                <motion.span
                  layoutId="step-indicator"
                  className="pointer-events-none absolute -inset-x-0.5 -inset-y-1 rounded-[3px] ring-1 ring-[var(--color-fg-primary)]/70"
                  transition={{ type: "spring", stiffness: 400, damping: 34 }}
                />
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsGroup({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function SettingsRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--color-fg-muted)]">{k}</dt>
      <dd className="font-mono text-[11px] text-[var(--color-fg-primary)]">{v}</dd>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-[var(--color-fg-secondary)]">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${
          checked ? "bg-[var(--color-accent-primary)]" : "bg-[var(--color-surface-400)]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

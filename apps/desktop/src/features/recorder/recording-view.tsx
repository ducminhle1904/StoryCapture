import type {
  RecordingV4Event,
  RecordingV4Result,
  RecordingV4Snapshot,
} from "@storycapture/shared-types/recording-v4";
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

import type { ProjectWorkflowSnapshot } from "@/features/project-workflow/project-stage";
import { ProjectStageHeader } from "@/features/project-workflow/project-stage-header";
import {
  type AutomationChannelHandle,
  type ExecutorEvent,
  launchAutomation,
} from "@/ipc/automation";
import {
  checkScreenCapturePermission,
  isStageManagerEnabled,
  openScreenCapturePrefs,
  relaunchApp,
  requestScreenCaptureAccess,
  type ScreenCapturePermissionReport,
} from "@/ipc/capture";
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
} from "@/state/output-prefs";
import { type RecorderStatus, type StepProgress, useRecorderStore } from "@/state/recorder";

// The recorder-side element picker has been removed. Element picking
// lives exclusively in the Preview panel via
// `apps/desktop/src/features/editor/PreviewPickerButton.tsx`.
import { ChromeHidingToggle } from "./ChromeHidingToggle";
import { CursorToggle } from "./CursorToggle";
import { formatIpcError } from "./ipc-error";
import { parsePrimaryMiss, RECORD_PATH_MISS_BODY } from "./primary-miss-copy";
import { storyInitialUrlForRecording } from "./recording-viewport";
import { TccPrompt } from "./tcc-prompt";
import { useRecordingV4Session } from "./use-recording-v4-session";

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

function strictPreflightFailureMessage(code: string): string {
  switch (code) {
    case "permission_denied":
      return "Allow Screen Recording in system settings";
    case "helper_unavailable":
      return "Native capture helper is unavailable";
    case "helper_protocol_mismatch":
      return "Native capture helper needs an update";
    case "hardware_encoder_unavailable":
      return "A hardware H.264 encoder is required";
    case "storage_probe_failed":
      return "Available storage could not be verified";
    case "storage_insufficient":
      return "Free storage before starting verified recording";
    case "write_throughput_insufficient":
      return "The selected drive is too slow for verified recording";
    case "audio_device_unavailable":
      return "The requested native audio source is unavailable";
    default:
      return code.replaceAll("_", " ");
  }
}

function nativeReadinessLabel(readiness: RecorderStatus | string | null): string {
  switch (readiness) {
    case "global_ready":
      return "Preparing browser target";
    case "target_ready":
      return "Waiting for initial surface";
    case "initial_surface_received":
      return "Native surface ready";
    default:
      return "Initializing";
  }
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
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
    readiness,
    liveEvidence,
    qualityFailure,
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
    setQualityFailure,
    resetTake,
    setPrimaryMiss,
  } = useRecorderStore();

  // Host heartbeat watchdog. `lastHeartbeatRef` is last-tick epoch-ms
  // (null before first heartbeat). `desynced` surfaces the "out of sync" UI.
  const lastHeartbeatRef = useRef<number | null>(null);
  const [desynced, setDesynced] = useState(false);

  // Reference to the automation Channel so unmount can null its handler.
  const automationChannelRef = useRef<AutomationChannelHandle | null>(null);

  // Mirror the active browser preset for ChromeHidingToggle.
  const [browserPreset, setBrowserPreset] = useState<string | null>(null);
  const appSettings = useAppSettingsStore((s) => s.settings);

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

  const sessionRef = useRef<string | null>(null);
  const completedSessionRef = useRef<string | null>(null);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const automationSessionRef = useRef<string | null>(null);
  const automationFailedOrdinalRef = useRef<number | null>(null);
  const handleRecordRef = useRef<(() => Promise<void>) | null>(null);
  const handleStopRef = useRef<((expectedSessionId?: string) => Promise<void>) | null>(null);

  const storyInitialUrl = useMemo(() => storyInitialUrlForRecording(storySource), [storySource]);
  const currentStepEntry = steps.length > 0 ? steps[Math.min(currentStep, steps.length - 1)] : null;
  const completedSteps = steps.filter((s) => s.status === "succeeded").length;

  const ownsActiveSession = (ownerSessionId: string): boolean =>
    sessionRef.current === ownerSessionId;

  const cleanupSessionResources = (ownerSessionId: string) => {
    if (automationSessionRef.current === ownerSessionId) {
      if (automationChannelRef.current) automationChannelRef.current.onmessage = null;
      automationChannelRef.current = null;
      automationSessionRef.current = null;
      automationFailedOrdinalRef.current = null;
    }
    if (stopInFlightRef.current === ownerSessionId) stopInFlightRef.current = null;
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
      } catch (e) {
        setError(formatIpcError(e));
      }
    })();
    // The V4 hook detaches renderer channels on unmount. The host transaction
    // remains alive and is reattached by the next renderer instance.
    return () => {
      if (automationChannelRef.current) {
        automationChannelRef.current.onmessage = null;
      }
      sessionRef.current = null;
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

  const finalizeRecording = (
    ownerSessionId: string,
    result: Extract<RecordingV4Result, { state: "completed" }>,
  ) => {
    if (!ownsActiveSession(ownerSessionId) || completedSessionRef.current === ownerSessionId) return;
    completedSessionRef.current = ownerSessionId;
    cleanupSessionResources(ownerSessionId);
    recordingV4.releaseTerminal(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("completed");
    setOutputPath(result.output_path);
    if (projectId) {
      const bundleSeparator = result.bundle_path.includes("\\") ? "\\" : "/";
      publishCompletedRecording(queryClient, projectId, {
        path: result.output_path,
        captured_at: Date.now(),
        duration_ms: liveEvidence && "active_duration_us" in liveEvidence
          ? Math.round(liveEvidence.active_duration_us / 1_000)
          : null,
        width: 1920,
        height: 1080,
        version: 4,
        bundle_path: result.bundle_path,
        master_path: result.output_path,
        proxy_path: null,
        cadence_evidence_path: `${result.bundle_path}${bundleSeparator}evidence${bundleSeparator}cadence.json`,
        quality_evidence_path: `${result.bundle_path}${bundleSeparator}evidence${bundleSeparator}quality.json`,
        actions_path: `${result.bundle_path}${bundleSeparator}sidecars${bundleSeparator}actions.json`,
        exact_source_fps: { numerator: 60, denominator: 1 },
        source_frame_count: liveEvidence && "output_frames" in liveEvidence
          ? liveEvidence.output_frames
          : null,
        certified_tier: null,
        quality_verdict: "passed",
        validation: { status: "valid" },
      });
    }
    toast.success("Verified recording complete", { description: result.output_path });
    if (autoOpenPostProduction && projectId) {
      navigate(`/post-production/${projectId}`, { replace: true });
    }
  };

  const failRecording = (ownerSessionId: string, message: string) => {
    if (!ownsActiveSession(ownerSessionId) || completedSessionRef.current === ownerSessionId)
      return;
    cleanupSessionResources(ownerSessionId);
    recordingV4.releaseTerminal(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("failed");
    setError(message);
    toast.error(`Recording failed: ${message}`);
  };

  const failQualityRecording = (
    ownerSessionId: string,
    result: Extract<RecordingV4Result, { state: "quality_failed" }>,
  ) => {
    if (completedSessionRef.current === ownerSessionId) return;
    completedSessionRef.current = ownerSessionId;
    cleanupSessionResources(ownerSessionId);
    recordingV4.releaseTerminal(ownerSessionId);
    sessionRef.current = null;
    startedAtRef.current = null;
    pausedAtRef.current = null;
    setSession(null);
    setStatus("quality_failed");
    setQualityFailure(result);
    setOutputPath(result.diagnostic_bundle_path);
    const message = result.failure_codes.join(", ");
    setError(message || "Verified recording did not pass quality checks");
    toast.error("Take was not published", {
      description: message || result.diagnostic_bundle_path || undefined,
    });
  };

  const applySnapshot = (snapshot: RecordingV4Snapshot) => {
    sessionRef.current = snapshot.session_id;
    setSession(snapshot.session_id);
    setElapsed(Math.round(snapshot.active_media_time_us / 1_000));
    if (snapshot.state === "capturing" && startedAtRef.current === null) {
      startedAtRef.current = Date.now() - Math.round(snapshot.active_media_time_us / 1_000);
    }
    if (snapshot.cadence) setLiveEvidence(snapshot.cadence);
    setReadiness(snapshot.state);
    const stateStatus: Partial<Record<typeof snapshot.state, RecorderStatus>> = {
      idle: "starting", preflighting: "preflight", warming_up: "preflight", ready: "starting",
      capturing: "recording", paused: "paused", stopping: "stopping", verifying: "verifying",
      completed: "completed", quality_failed: "quality_failed", failed: "failed",
    };
    const next = stateStatus[snapshot.state];
    if (next) setStatus(next);
    if (snapshot.terminal_result) dispatchTerminal(snapshot.terminal_result);
  };

  const dispatchTerminal = (result: RecordingV4Result) => {
    const ownerSessionId = result.session_id;
    if (result.state === "completed") finalizeRecording(ownerSessionId, result);
    else if (result.state === "quality_failed") failQualityRecording(ownerSessionId, result);
    else if (result.state === "failed") {
      failRecording(ownerSessionId, result.failure_codes.join(", ") || "Native recording failed");
    } else {
      cleanupSessionResources(ownerSessionId);
      recordingV4.releaseTerminal(ownerSessionId);
      sessionRef.current = null;
      setSession(null);
      setStatus("idle");
    }
  };

  const dispatch = (event: RecordingV4Event) => {
    switch (event.type) {
      case "snapshot":
        applySnapshot(event.snapshot);
        break;
      case "preflight":
        setPreflight(event.result);
        if (!event.result.passed) {
          setError(event.result.failure_codes.map(strictPreflightFailureMessage).join(" · "));
        }
        break;
      case "state-changed":
        setReadiness(event.to);
        applySnapshot({
          version: 4, session_id: sessionRef.current ?? "", state: event.to,
          revision: event.revision, active_media_time_us: elapsedMs * 1_000,
          requested_audio_roles: audioDeviceId ? ["microphone"] : [], cadence: null,
          terminal_result: null,
        });
        break;
      case "live-evidence":
        setLiveEvidence(event.cadence);
        break;
      case "terminal":
        dispatchTerminal(event.result);
        break;
      case "heartbeat":
        lastHeartbeatRef.current = Date.now();
        setDesynced(false);
        break;
      default:
        break;
    }
  };

  const recordingV4 = useRecordingV4Session(projectFolder, {
    onEvent: dispatch,
    onReattached: (id) => {
      sessionRef.current = id;
      setSession(id);
      completedSessionRef.current = null;
    },
    onReattachError: (error) => {
      setStatus("failed");
      setError(`Could not reattach recording; reload to retry: ${formatIpcError(error)}`);
    },
  });

  const handleRecord = async () => {
    if (startInFlightRef.current || useRecorderStore.getState().status !== "idle") return;
    startInFlightRef.current = true;
    setStatus("starting");
    setDesynced(false);
    lastHeartbeatRef.current = null;
    if (permission !== "granted") {
      setStatus("idle");
      startInFlightRef.current = false;
      return;
    }
    if (!storyInitialUrl) {
      toast.error("Verified recording requires a browser URL in meta.app.");
      setStatus("idle");
      startInFlightRef.current = false;
      return;
    }
    startedAtRef.current = Date.now();
    pausedAtRef.current = null;
    automationFailedOrdinalRef.current = null;
    try {
      const pacingProfile = DEFAULT_RECORDING_PACING;
      const recordingViewport = { width: 960, height: 540 };
      const ownerSessionId = await recordingV4.start({
        project_path: projectFolder,
        source_url: storyInitialUrl,
        logical_width: recordingViewport.width,
        logical_height: recordingViewport.height,
        requested_audio_roles: audioDeviceId ? ["microphone"] : [],
        include_cursor: includeCursor,
      });
      if (!ownerSessionId) {
        startInFlightRef.current = false;
        return;
      }
      sessionRef.current = ownerSessionId;
      completedSessionRef.current = null;
      setSession(ownerSessionId);
      if (!ownsActiveSession(ownerSessionId)) {
        startInFlightRef.current = false;
        return;
      }
      setStatus("recording");
      startInFlightRef.current = false;

      automationSessionRef.current = ownerSessionId;
      launchAutomation(
        {
          storySource,
          projectFolder,
          streamId: null,
          chromeHiding,
          recordingViewport,
          pacingProfile,
          recordingV4SessionId: ownerSessionId,
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
          void handleStop(ownerSessionId);
        })
        .catch((e) => {
          if (!ownsActiveSession(ownerSessionId)) return;
          const msg = formatIpcError(e);
          toast.error(`Automation failed: ${msg}`);
          setError(msg);
          void handleStop(ownerSessionId);
        });
    } catch (e) {
      setError(formatIpcError(e));
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
        window.setTimeout(() => {
          void handleStop(ownerSessionId);
        }, 500);
        break;
      default:
        break;
    }
  };

  const handleStop = async (expectedSessionId?: string) => {
    if (!sessionRef.current) return;
    const ownerSessionId = sessionRef.current;
    if (expectedSessionId && expectedSessionId !== ownerSessionId) return;
    if (stopInFlightRef.current === ownerSessionId) return;
    stopInFlightRef.current = ownerSessionId;
    setStatus("stopping");
    try {
      await recordingV4.command("stop");
    } catch (e) {
      if (!ownsActiveSession(ownerSessionId)) return;
      const message = formatIpcError(e);
      setStatus("failed");
      setError(message);
      toast.error(`Stop failed: ${message}`);
    } finally {
      if (stopInFlightRef.current === ownerSessionId) stopInFlightRef.current = null;
    }
  };

  const forceStop = async () => {
    setDesynced(false);
    try {
      await recordingV4.command("stop");
    } catch (e) {
      frontendLog.warn("RecordingView", "forceStop: V4 stop error", {
        error: e,
        fields: { ipc_error: formatIpcError(e) },
      });
      setError(`Stop retry failed: ${formatIpcError(e)}`);
    }
  };

  const handlePause = async () => {
    if (!sessionRef.current || status !== "recording") return;
    try {
      await recordingV4.command("pause");
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
      await recordingV4.command("resume");
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

  const canRecord = permission === "granted" && storyInitialUrl != null;
  const canRecordDisplay = canRecord;
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
        disabled: !canRecordDisplay,
        title: !canRecordDisplay ? "Resolve permissions and add a browser URL" : undefined,
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
        workflowLabel="Verified 1080p60 recording"
        currentStage="record"
        snapshot={workflowSnapshot}
        navigationLocked={navigationLocked}
        primaryAction={primaryAction}
      />

      {status === "recording" ||
      status === "paused" ||
      status === "verifying" ? (
        <div className="flex min-h-9 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4">
          {status === "recording" || status === "paused" ? (
            <LiveRecordingBadge paused={status === "paused"} reduceMotion={!!reduceMotion} />
          ) : null}
          {status === "verifying" ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-accent)]">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              Verifying native evidence
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
                  toast.success("Debug permission bypassed");
                }
              : undefined
          }
        />
      ) : null}

      {preflight ? (
        <div
          role="status"
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-xs ${
            preflight.passed
              ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10"
              : "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {preflight.passed ? (
              <CheckCircle2 size={13} className="text-[var(--color-success)]" aria-hidden="true" />
            ) : (
              <AlertTriangle size={13} className="text-[var(--color-danger)]" aria-hidden="true" />
            )}
            <span className="font-medium text-[var(--color-fg-primary)]">
              {preflight.passed ? "Verified preflight passed" : "Verified preflight blocked"}
            </span>
            <span className="text-[var(--color-fg-secondary)]">
              {`${preflight.platform === "darwin" ? "ScreenCaptureKit" : "Windows Graphics Capture"} · ${preflight.encoder?.encoder_id ?? "hardware H.264 unavailable"}`}
            </span>
          </div>
          <span className="font-mono text-[11px] text-[var(--color-fg-secondary)]">
            {liveEvidence
              ? `${liveEvidence.output_frames} frames · ${liveEvidence.held_frames} held`
              : preflight.failure_codes.join(", ") || "60/1 · 1920×1080"}
          </span>
          {!preflight.passed ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-[var(--color-danger)]/20 pt-2">
              <span className="text-[var(--color-fg-secondary)]">
                {preflight.failure_codes.map(strictPreflightFailureMessage).join(" · ")}
              </span>
              <button
                type="button"
                onClick={() => {
                  resetTake();
                }}
                className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)]"
              >
                Retry preflight
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {qualityFailure ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-2 text-xs">
          <div className="min-w-0">
            <div className="font-medium text-[var(--color-fg-primary)]">
              Take was not published
            </div>
            <div className="truncate text-[var(--color-fg-secondary)]">
              {qualityFailure.failure_codes.join(", ") || "Verification failed"}
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
              {status === "idle" && canRecord ? (
                <span>Ready · {steps.length} steps</span>
              ) : status === "idle" && !canRecord ? (
                <span>Resolve permissions to record</span>
              ) : status === "recording" ? (
                <span>Recording in progress</span>
              ) : status === "paused" ? (
                <span>Recording paused</span>
              ) : status === "verifying" ? (
                <span>Verifying cadence, native master integrity, and visual quality</span>
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
                <span className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-fg-secondary)]">
                  Verified 1080p · 60 fps
                </span>
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
              <SettingsRow
                k="Source"
                v={storyInitialUrl ? "Author preview" : "Missing meta.app URL"}
              />
              {status !== "idle" ? (
                <SettingsRow k="Native capture" v={nativeReadinessLabel(readiness)} />
              ) : null}
              <SettingsRow k="Audio" v={audioDeviceId ? "Native microphone requested" : "Video only"} />
              <SettingsRow k="Output" v="Verified 1920×1080 · 60 fps" />
            </div>
          </section>

          <details className="group rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
            <summary className="cursor-pointer list-none px-3 py-2.5 text-[11px] font-semibold text-[var(--color-fg-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]">
              Advanced settings
            </summary>
            <div className="flex flex-col gap-4 border-t border-[var(--color-border-subtle)] px-3 py-3">
              <SettingsGroup label="Audio" icon={<SettingsIcon size={13} />}>
                <Toggle
                  label="Native microphone"
                  checked={audioDeviceId !== null}
                  onChange={(enabled) => setAudioDeviceId(enabled ? "default" : null)}
                />
                <p className="mt-1.5 text-[10px] text-[var(--color-fg-muted)]">
                  Captured by the native helper. Recording fails closed when the requested audio
                  role cannot pass preflight.
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

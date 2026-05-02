import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  Monitor,
  Pause,
  Play,
  Settings as SettingsIcon,
  Square as StopIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { TargetPicker } from "@/features/capture/TargetPicker";
import { stopPreviewNow } from "@/features/editor/preview-lifecycle";
import {
  type AutomationChannelHandle,
  type ExecutorEvent,
  launchAutomation,
} from "@/ipc/automation";
import {
  checkScreenCapturePermission,
  type CaptureTarget,
  type DisplayInfo,
  isStageManagerEnabled,
  openScreenCapturePrefs,
  type PermissionState,
  relaunchApp,
  requestScreenCaptureAccess,
} from "@/ipc/capture";
import {
  pauseRecording,
  type RecordingEvent,
  type RecordingSessionId,
  resumeRecording,
  startRecording,
  stopRecording,
} from "@/ipc/encode";
import { parseStory } from "@/ipc/parse";
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
import { CursorTrail } from "./cursor-trail";
import { parsePrimaryMiss, RECORD_PATH_MISS_BODY } from "./primary-miss-copy";
import { TccPrompt } from "./tcc-prompt";
import { OutputSummaryBadge } from "./video-output/output-summary-badge";
import { useIsRecordingBlocked, VideoOutputSection } from "./video-output/video-output-section";

interface RecordingViewProps {
  projectId: string | null;
  projectName: string;
  projectFolder: string;
  storySource: string;
  autoOpenPostProduction?: boolean;
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
  return typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "NotFound";
}

/** Format a Tauri IPC error into a readable string. */
function formatIpcError(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object") {
    // Tauri AppError shape: { kind: string, message?: string, ... }
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.kind ? `${obj.kind}: ${obj.message}` : obj.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

function displayId(display: DisplayInfo): number {
  return typeof display.id === "bigint" ? Number(display.id) : display.id;
}

interface BrowserViewportSize {
  width: number;
  height: number;
}

const DEFAULT_BROWSER_VIEWPORT: BrowserViewportSize = { width: 1280, height: 800 };
const RECORDING_BROWSER_CHROME_VERTICAL_BUDGET = 120;

function storyViewportSize(source: string): BrowserViewportSize {
  const pair = source.match(/\bviewport\s*:\s*(\d{2,5})\s*x\s*(\d{2,5})\b/i);
  if (pair) {
    return { width: Number(pair[1]), height: Number(pair[2]) };
  }

  const named = source.match(/\bviewport\s*:\s*(desktop|tablet|mobile)\b/i)?.[1]?.toLowerCase();
  switch (named) {
    case "desktop":
      return { width: 1280, height: 800 };
    case "tablet":
      return { width: 1024, height: 768 };
    case "mobile":
      return { width: 375, height: 667 };
    default:
      return DEFAULT_BROWSER_VIEWPORT;
  }
}

function preferDisplay(a: DisplayInfo, b: DisplayInfo): DisplayInfo {
  if (a.scale_factor !== b.scale_factor) {
    return a.scale_factor > b.scale_factor ? a : b;
  }
  if (a.is_primary !== b.is_primary) {
    return a.is_primary ? a : b;
  }
  return a;
}

function displayLogicalSize(display: DisplayInfo): BrowserViewportSize {
  const scale =
    Number.isFinite(display.scale_factor) && display.scale_factor > 0 ? display.scale_factor : 1;
  return {
    width: Math.max(1, Math.floor(display.width_px / scale)),
    height: Math.max(1, Math.floor(display.height_px / scale)),
  };
}

function displayArea(display: DisplayInfo): number {
  const logical = displayLogicalSize(display);
  return logical.width * logical.height;
}

function preferDisplayArea(a: DisplayInfo, b: DisplayInfo): DisplayInfo {
  if (displayArea(a) !== displayArea(b)) {
    return displayArea(a) > displayArea(b) ? a : b;
  }
  return preferDisplay(a, b);
}

function browserChromeBudget(chromeHiding: boolean): number {
  return chromeHiding ? 0 : RECORDING_BROWSER_CHROME_VERTICAL_BUDGET;
}

function browserWindowFitsDisplay(
  display: DisplayInfo,
  viewport: BrowserViewportSize,
  chromeHiding: boolean,
): boolean {
  // App-mode can fall back to a normal Chromium window, so fit against a
  // conservative browser-chrome budget in logical pixels only when chrome
  // hiding is off. In app-mode we crop to browser content; shrinking a
  // 1920x1080 viewport to 1706x960 on a 1080p external display destroys
  // detail before the encoder ever sees the frame.
  const verticalChromeBudget = browserChromeBudget(chromeHiding);
  const logical = displayLogicalSize(display);
  return (
    logical.width >= viewport.width && logical.height >= viewport.height + verticalChromeBudget
  );
}

function fitBrowserViewportToDisplay(
  viewport: BrowserViewportSize,
  display: DisplayInfo | undefined,
  chromeHiding: boolean,
): {
  viewport: BrowserViewportSize;
  displayLogical: BrowserViewportSize | null;
  scale: number;
  scaled: boolean;
} {
  if (!display) {
    return { viewport, displayLogical: null, scale: 1, scaled: false };
  }

  const verticalChromeBudget = browserChromeBudget(chromeHiding);
  const displayLogical = displayLogicalSize(display);
  const maxWidth = Math.max(1, displayLogical.width);
  const maxHeight = Math.max(1, displayLogical.height - verticalChromeBudget);
  const scale = Math.min(1, maxWidth / viewport.width, maxHeight / viewport.height);
  const fitted = {
    width: Math.max(1, Math.min(maxWidth, Math.floor(viewport.width * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.floor(viewport.height * scale))),
  };

  return {
    viewport: fitted,
    displayLogical,
    scale,
    scaled: fitted.width !== viewport.width || fitted.height !== viewport.height,
  };
}

function chooseBrowserLaunchDisplay(
  displays: DisplayInfo[],
  selected: DisplayInfo | undefined,
  viewport: BrowserViewportSize,
  chromeHiding: boolean,
): DisplayInfo | undefined {
  if (selected) return selected;

  const fitting = displays.filter((candidate) =>
    browserWindowFitsDisplay(candidate, viewport, chromeHiding),
  );
  if (fitting.length > 0) {
    const bestFit = fitting.reduce<DisplayInfo | undefined>(
      (acc, candidate) => (acc ? preferDisplay(acc, candidate) : candidate),
      undefined,
    );
    return bestFit;
  }

  return displays.reduce<DisplayInfo | undefined>(
    (acc, candidate) => (acc ? preferDisplayArea(acc, candidate) : candidate),
    selected,
  );
}

export function RecordingView({
  projectId,
  projectName,
  projectFolder,
  storySource,
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
  const [permission, setPermission] = useState<PermissionState>("undetermined");
  const [tccOpen, setTccOpen] = useState(false);
  // Local state only drives the countdown affordance.
  const [useCountdown, setUseCountdown] = useState(true);
  // Stage Manager breaks SCK window-target capture for off-stage
  // windows — surface a pre-flight warning so users can disable it
  // before recording, matching Screen Studio / CleanShot X UX.
  const [stageManagerWarning, setStageManagerWarning] = useState(false);

  const sessionRef = useRef<RecordingSessionId | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const automationOwnsStopRef = useRef(false);
  const videoOutputSectionRef = useRef<HTMLDivElement | null>(null);
  const isOutputBlocked = useIsRecordingBlocked();

  const displays = availableTargets?.displays ?? [];
  const selectedDisplay: number | null =
    captureTarget?.kind === "display"
      ? typeof captureTarget.display_id === "bigint"
        ? Number(captureTarget.display_id)
        : captureTarget.display_id
      : null;

  const currentStepEntry = steps.length > 0 ? steps[Math.min(currentStep, steps.length - 1)] : null;
  const completedSteps = steps.filter((s) => s.status === "succeeded").length;

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
        let perm = await checkScreenCapturePermission();
        // Register the app in Screen Recording settings if needed.
        if (perm !== "granted") {
          perm = await requestScreenCaptureAccess();
        }
        setPermission(perm);
        // Don't auto-open the prompt on Sequoia false-negatives.
        if (perm === "granted") {
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
      //     the host drain doesn't leak a session. Capture the id before
      //     nulling the ref so a re-mount can't double-free.
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) {
        void stopRecording(sid).catch((e) => {
          frontendLog.warn("RecordingView", "stopRecording on unmount failed", {
            error: e,
            fields: { session_id: sid },
          });
        });
      }
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

  const dispatch = (event: RecordingEvent) => {
    switch (event.type) {
      case "completed":
        sessionRef.current = null;
        startedAtRef.current = null;
        pausedAtRef.current = null;
        automationOwnsStopRef.current = false;
        setSession(null);
        setStatus("completed");
        setOutputPath(event.result.output_path);
        toast.success("Recording complete", {
          description: event.result.output_path,
        });
        if (autoOpenPostProduction && projectId) {
          navigate(`/post-production/${projectId}`, { replace: true });
        }
        break;
      case "failed":
        sessionRef.current = null;
        startedAtRef.current = null;
        pausedAtRef.current = null;
        automationOwnsStopRef.current = false;
        setSession(null);
        setStatus("failed");
        setError(event.message);
        toast.error(`Recording failed: ${event.message}`);
        break;
      case "audio-unavailable":
        // Mic negotiation failed; recording continues video-only.
        toast.error(`Audio unavailable: ${event.reason}`);
        setAudioUnavailable(true);
        break;
      case "heartbeat":
        // Host liveness signal; watchdog clears any desync banner.
        lastHeartbeatRef.current = Date.now();
        if (desynced) setDesynced(false);
        break;
      default:
        break;
    }
  };

  const handleRecord = async () => {
    // Double-start guard. Synchronous status flip before any await so a
    // 10 ms double-click cannot enter this function twice.
    if (status !== "idle") return;
    setStatus("starting");
    // Fresh per-session UX state for the audio/heartbeat badges.
    setAudioUnavailable(false);
    setDesynced(false);
    lastHeartbeatRef.current = null;
    if (permission !== "granted") {
      setStatus("idle");
      return;
    }
    if (selectedDisplay == null) {
      toast.error("Pick a Target before recording.");
      setStatus("idle");
      return;
    }
    startedAtRef.current = Date.now();
    pausedAtRef.current = null;
    automationOwnsStopRef.current = false;
    const display = displays.find((d) => {
      return displayId(d) === selectedDisplay;
    });
    // Seed with display dims; auto-follow may overwrite with the
    // resolved Playwright window's dims so the encoder canvas matches
    // the actual SCK stream output.
    let width = display?.width_px ?? 1920;
    let height = display?.height_px ?? 1080;
    try {
      const storyHasBrowser = /\bapp\s*:\s*["']https?:\/\//i.test(storySource);
      const storyViewport = storyViewportSize(storySource);
      const pacingProfile = DEFAULT_RECORDING_PACING;
      if (storyHasBrowser) {
        await stopPreviewNow("recording-start");
      }
      const launchDisplay = storyHasBrowser
        ? chooseBrowserLaunchDisplay(displays, display, storyViewport, chromeHiding)
        : display;
      const recordingDisplay = launchDisplay ? { x: launchDisplay.x, y: launchDisplay.y } : null;
      const viewportFit = storyHasBrowser
        ? fitBrowserViewportToDisplay(storyViewport, launchDisplay, chromeHiding)
        : { viewport: storyViewport, displayLogical: null, scale: 1, scaled: false };
      const recordingViewport = storyHasBrowser ? viewportFit.viewport : null;
      const recordingFullscreen =
        storyHasBrowser &&
        chromeHiding &&
        viewportFit.displayLogical != null &&
        viewportFit.viewport.width === viewportFit.displayLogical.width &&
        viewportFit.viewport.height === viewportFit.displayLogical.height;
      if (storyHasBrowser && launchDisplay) {
        frontendLog.info("RecordingView", "browser recording viewport plan", {
          fields: {
            selected_display_id: display ? displayId(display) : null,
            selected_display_name: display?.name ?? null,
            selected_display_scale: display?.scale_factor ?? null,
            launch_display_id: displayId(launchDisplay),
            launch_display_name: launchDisplay.name,
            launch_display_scale: launchDisplay.scale_factor,
            launch_display_physical_width: launchDisplay.width_px,
            launch_display_physical_height: launchDisplay.height_px,
            launch_display_logical_width: viewportFit.displayLogical?.width ?? null,
            launch_display_logical_height: viewportFit.displayLogical?.height ?? null,
            requested_viewport_width: storyViewport.width,
            requested_viewport_height: storyViewport.height,
            effective_viewport_width: viewportFit.viewport.width,
            effective_viewport_height: viewportFit.viewport.height,
            viewport_fit_scale: viewportFit.scale,
            viewport_was_scaled: viewportFit.scaled,
            recording_fullscreen: recordingFullscreen,
            launch_display_fits_requested_viewport: browserWindowFitsDisplay(
              launchDisplay,
              storyViewport,
              chromeHiding,
            ),
          },
        });
        if (viewportFit.scaled) {
          toast.info(
            `Browser viewport scaled to ${viewportFit.viewport.width}x${viewportFit.viewport.height} to fit the recording display`,
          );
        }
      }
      if (
        storyHasBrowser &&
        display &&
        launchDisplay &&
        displayId(display) !== displayId(launchDisplay)
      ) {
        frontendLog.info("RecordingView", "using HiDPI display for browser recording launch", {
          fields: {
            selected_display_id: displayId(display),
            selected_display_name: display.name,
            selected_display_scale: display.scale_factor,
            launch_display_id: displayId(launchDisplay),
            launch_display_name: launchDisplay.name,
            launch_display_scale: launchDisplay.scale_factor,
            launch_display_x: launchDisplay.x,
            launch_display_y: launchDisplay.y,
            story_viewport_width: storyViewport.width,
            story_viewport_height: storyViewport.height,
            effective_viewport_width: viewportFit.viewport.width,
            effective_viewport_height: viewportFit.viewport.height,
            launch_display_fits_viewport: browserWindowFitsDisplay(
              launchDisplay,
              storyViewport,
              chromeHiding,
            ),
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
      if (shouldAutoFollow) {
        // Launch Playwright *before* capture so the window exists.
        launchAutomation(
          {
            storySource,
            projectFolder,
            chromeHiding,
            pacingProfile,
            recordingDisplay,
            recordingViewport,
          },
          (evt) => dispatchAutomation(evt),
          (ch) => {
            automationChannelRef.current = ch;
          },
        ).catch((e) => {
          const msg = formatIpcError(e);
          toast.error(`Automation failed: ${msg}`);
          setError(msg);
        });
        // Poll the HOST directly for the Chromium pid (bypassing the
        // store's 1s-debounced refresher). Up to 8s; return as soon as
        // resolvePlaywrightTarget returns non-null.
        const { resolvePlaywrightTarget } = await import("@/ipc/capture");
        const deadline = Date.now() + 8_000;
        let resolved: Awaited<ReturnType<typeof resolvePlaywrightTarget>> = null;
        while (Date.now() < deadline) {
          try {
            const hit = await resolvePlaywrightTarget();
            if (hit && hit.window_id != null) {
              resolved = hit;
              break;
            }
          } catch {
            /* keep polling */
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        if (resolved) {
          recordingTarget = {
            kind: "window" as const,
            window_id: resolved.window_id,
          };
          // Use the resolved window's pixel dimensions for the encoder
          // canvas. Without this the encoder inherits display dims while
          // SCK streams at window dims, producing black padding around
          // the browser content (or buffer-size mismatch drops at
          // FFmpeg). `0` signals "unknown" (Windows path) — fall back.
          if (resolved.width_px > 0 && resolved.height_px > 0) {
            width = resolved.width_px;
            height = resolved.height_px;
          }
          if (
            chromeHiding &&
            resolved.content_crop &&
            resolved.content_crop.w > 0 &&
            resolved.content_crop.h > 0
          ) {
            frameCrop = resolved.content_crop;
            toast.info("Recording just the browser content");
          } else {
            toast.info("Recording just the browser window");
          }
        } else {
          const msg =
            "Browser target is not available. Restore the browser window and try recording again.";
          frontendLog.warn("RecordingView", "browser auto-target unavailable; refusing display fallback", {
            fields: {
              deadline_ms: 8000,
              recording_target_kind: recordingTarget.kind,
              story_has_browser: storyHasBrowser,
            },
          });
          toast.error(msg);
          setError(msg);
          setStatus("idle");
          return;
        }
      }
      // Output knobs from useOutputPrefsStore (one-shot read).
      const { activePreset, recordingKnobs: prefs } = useOutputPrefsStore.getState();
      const id = await startRecording(
        {
          project_folder: projectFolder,
          target: recordingTarget,
          width,
          height,
          fps: prefs.fps,
          audio_device_id: audioDeviceId ?? undefined,
          include_cursor: includeCursor,
          output_resolution: recordingOutputResolutionForStart(prefs, activePreset),
          fit_mode: prefs.fit,
          pad_color: prefs.pad,
          quality_preset: prefs.quality,
          scale_algo: "lanczos",
          frame_crop: frameCrop,
        },
        (event) => dispatch(event),
      );
      sessionRef.current = id;
      setSession(typeof (id as unknown) === "string" ? (id as unknown as string) : id.id);
      // Transition starting -> recording only after the host has
      // confirmed the session. If we error out above, the catch arm
      // resets to "idle" so the Start button re-enables.
      setStatus("recording");

      // Launch DSL automation here ONLY if we didn't already launch it
      // for auto-follow (`shouldAutoFollow` fires launchAutomation BEFORE
      // capture starts so the Chromium pid is resolvable). Otherwise, we'd
      // spawn two Playwright sessions.
      if (!shouldAutoFollow) {
        automationOwnsStopRef.current = true;
        launchAutomation(
          {
            storySource,
            projectFolder,
            chromeHiding,
            recordingDisplay,
            recordingViewport,
            pacingProfile,
            recordingSessionId:
              typeof (id as unknown) === "string" ? (id as unknown as string) : id.id,
          },
          (evt) => dispatchAutomation(evt),
          (ch) => {
            automationChannelRef.current = ch;
          },
        ).catch((e) => {
          automationOwnsStopRef.current = false;
          const msg = formatIpcError(e);
          toast.error(`Automation failed: ${msg}`);
          setError(msg);
        });
      }
    } catch (e) {
      setError(formatIpcError(e));
      // Error path resets to idle so the Start button re-enables; the
      // toast + error banner still surface the failure to the user.
      setStatus("idle");
      toast.error(`Recording failed to start: ${formatIpcError(e)}`);
    }
  };

  // Map automation events onto the step rail.
  const dispatchAutomation = (evt: ExecutorEvent) => {
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
            if (sessionRef.current) void handleStop();
          }, 500);
        }
        break;
      default:
        break;
    }
  };

  const handleStop = async () => {
    if (!sessionRef.current) return;
    const session = sessionRef.current;
    setStatus("stopping");
    try {
      const result = await stopRecording(session);
      dispatch({ type: "completed", result });
    } catch (e) {
      sessionRef.current = null;
      startedAtRef.current = null;
      setSession(null);
      const message = formatIpcError(e);
      setStatus("failed");
      setError(message);
      toast.error(`Stop failed: ${message}`);
    }
  };

  // "Force stop" escape hatch surfaced when the heartbeat watchdog
  // declares a desync. Always resets local state to idle regardless of
  // IPC outcome — NotFound is treated as success (session already gone).
  const forceStop = async () => {
    const sid = sessionRef.current;
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
    automationOwnsStopRef.current = false;
    setStatus("idle");
    setElapsed(0);
  };

  const handlePause = async () => {
    if (!sessionRef.current || status !== "recording") return;
    try {
      await pauseRecording(sessionRef.current);
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
      await resumeRecording(sessionRef.current);
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

  // ⌘R / Ctrl+R toggles recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        if (status === "idle") void handleRecord();
        else if (status === "recording" || status === "paused") void handleStop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, permission, selectedDisplay]);

  const canRecord = permission === "granted" && captureTarget != null;
  // Display-only code path for `handleRecord`.
  const canRecordDisplay = canRecord && selectedDisplay != null;
  const permissionDenied = permission === "denied";
  const permissionPending = permission === "undetermined";

  return (
    <main id="main-content" className="relative flex h-full flex-col bg-[var(--color-bg-primary)]">
      <CursorTrail />

      {/* ─── Header ─── */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-1.5">
        <div className="flex items-center gap-3">
          {/* Back to editor (falls back to dashboard). Blocked while recording. */}
          {status === "recording" || status === "paused" || status === "stopping" ? (
            <span
              aria-label="Back button disabled during recording"
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[var(--color-fg-muted)] opacity-50"
              title="Stop recording to go back"
            >
              <ArrowLeft size={14} aria-hidden="true" />
            </span>
          ) : (
            <Link
              to={projectId ? `/editor/${projectId}` : "/"}
              aria-label={projectId ? "Back to editor" : "Back to projects"}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <ArrowLeft size={14} aria-hidden="true" />
            </Link>
          )}

          <div className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
            {projectId ? (
              <Link
                to={`/editor/${projectId}`}
                className="transition-colors hover:text-[var(--color-fg-primary)]"
              >
                Editor
              </Link>
            ) : (
              <span>Record</span>
            )}
            <span>/</span>
            <span className="font-medium text-[var(--color-fg-primary)]">{projectName}</span>
            <span>/</span>
            <span>Record</span>
          </div>
          {(status === "recording" || status === "paused") && (
            <LiveRecordingBadge paused={status === "paused"} reduceMotion={!!reduceMotion} />
          )}
          {/* Persistent badge while a mic failure is active. */}
          {audioUnavailable && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--color-warning)]"
            >
              <AlertTriangle size={11} aria-hidden="true" />
              Audio unavailable — recording video only
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
          {sessionId ? <span className="font-mono">session · {sessionId.slice(0, 8)}</span> : null}
        </div>
      </header>

      {/* ─── Permission banner (inline, not modal) ─── */}
      {permissionDenied || permissionPending ? (
        <PermissionBanner
          state={permission}
          onOpenSettings={async () => {
            // Register the app in TCC first.
            try {
              await requestScreenCaptureAccess();
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
            setPermission(next);
            if (next === "granted") {
              try {
                await loadCaptureTargets();
              } catch (e) {
                toast.error(`loadCaptureTargets failed: ${formatIpcError(e)}`);
              }
              toast.success("Screen recording permission granted");
            } else {
              toast.message("Permission still needed", {
                description:
                  "After granting in System Settings, relaunch StoryCapture so macOS picks up the change.",
              });
            }
          }}
          onBypass={async () => {
            // Let the user override Sequoia false-negatives.
            setPermission("granted");
            setTccOpen(false);
            try {
              await loadCaptureTargets();
              toast.success("Permission check bypassed");
            } catch (e) {
              toast.error(`Could not load capture targets: ${formatIpcError(e)}`);
            }
          }}
        />
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
              ) : status === "completed" ? (
                <span className="text-[var(--color-success)]">Recording complete</span>
              ) : status === "failed" ? (
                <span className="text-[var(--color-danger)]">Recording failed</span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {status === "idle" && (
                <>
                  <OutputSummaryBadge
                    onActivate={() => {
                      videoOutputSectionRef.current?.scrollIntoView({
                        behavior: reduceMotion ? "auto" : "smooth",
                        block: "center",
                      });
                    }}
                  />
                  <RecordButton
                    disabled={!canRecordDisplay || isOutputBlocked}
                    onClick={handleRecord}
                  />
                </>
              )}
              {status === "recording" && (
                <>
                  {/* Recorder-side element picker removed; picking is
                      exclusively author-side via PreviewPickerButton in
                      the Preview panel. */}
                  <button
                    onClick={handlePause}
                    aria-label="Pause recording"
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] transition-[transform,background-color] duration-150 hover:bg-[var(--color-surface-300)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    <Pause size={13} aria-hidden="true" />
                    Pause
                  </button>
                  <button
                    onClick={handleStop}
                    aria-label="Stop recording"
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-[transform,filter] duration-150 hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    <StopIcon size={13} aria-hidden="true" />
                    Stop
                  </button>
                </>
              )}
              {status === "paused" && (
                <>
                  <button
                    onClick={handleResume}
                    aria-label="Resume recording"
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-warning)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] transition-[transform,filter] duration-150 hover:brightness-105 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    <Play size={13} aria-hidden="true" />
                    Resume
                  </button>
                  <button
                    onClick={handleStop}
                    aria-label="Stop recording"
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-white transition-[transform,filter] duration-150 hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    <StopIcon size={13} aria-hidden="true" />
                    Stop
                  </button>
                </>
              )}
              {status === "completed" && (
                <button
                  onClick={() => {
                    reset();
                    setStatus("idle");
                    applyRecorderDefaults();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs text-[var(--color-fg-primary)] hover:bg-[var(--color-surface-300)]"
                >
                  New take
                </button>
              )}
            </div>
          </div>
        </section>

        {/* RIGHT: settings rail */}
        <aside className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden bg-[var(--color-surface-100)] px-4 py-4">
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
              disabled={
                !canRecord || status === "recording" || status === "paused" || status === "stopping"
              }
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
              disabled={status === "recording" || status === "paused" || status === "stopping"}
            />
            <p className="mt-1.5 text-[10px] text-[var(--color-fg-muted)]">
              Default is off; choose "System default" to include voice-over. Resets every recording.
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
                disabled={status === "recording" || status === "paused" || status === "stopping"}
              />
              {/* Chrome-hiding toggle (non-sticky, defaults OFF). */}
              <ChromeHidingToggle
                checked={chromeHiding}
                onChange={setChromeHiding}
                browserPreset={browserPreset}
                disabled={status === "recording" || status === "paused" || status === "stopping"}
              />
              <Toggle label="3s countdown" checked={useCountdown} onChange={setUseCountdown} />
            </div>
          </SettingsGroup>

          <VideoOutputSection
            ref={videoOutputSectionRef}
            disabled={status === "recording" || status === "paused" || status === "stopping"}
          />

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
      <TccPrompt open={tccOpen} permission={permission} onDismiss={() => setTccOpen(false)} />
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
  state,
  onOpenSettings,
  onRelaunch,
  onRecheck,
  onBypass,
}: {
  state: PermissionState;
  onOpenSettings: () => void;
  onRelaunch: () => void;
  onRecheck: () => void;
  onBypass: () => void;
}) {
  const isDenied = state === "denied";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-4 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-[var(--color-warning)]">
        <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
        <span className="font-medium text-[var(--color-fg-primary)]">
          {isDenied ? "Screen recording permission denied." : "Screen recording permission needed."}
        </span>
        <span className="text-[var(--color-fg-secondary)]">
          macOS Sequoia sometimes reports stale state. If you've already granted, click "Already
          granted".
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={onBypass}
          title="Skip the permission check and try to record anyway"
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[11px] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)]"
        >
          Already granted
        </button>
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

        {status === "failed" && error && (
          <motion.div
            key="failed"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            className="relative flex max-w-md flex-col items-center text-center"
          >
            <AlertTriangle size={26} className="text-[var(--color-danger)]" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-[var(--color-fg-primary)]">
              Recording failed
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

function RecordButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Start recording"
      className="group inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--color-danger)] px-4 py-1.5 text-xs font-medium text-white shadow-[0_6px_20px_-8px_rgba(207,45,86,0.55)] transition-[transform,filter,box-shadow] duration-150 hover:brightness-110 hover:shadow-[0_10px_24px_-8px_rgba(207,45,86,0.65)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
    >
      <span className="grid h-4 w-4 place-items-center">
        <span className="h-2 w-2 rounded-full bg-white" />
      </span>
      Start recording
      <kbd className="font-mono ml-1 rounded-[var(--radius-xs)] bg-white/15 px-1 py-0.5 text-[9px] tabular-nums">
        ⌘R
      </kbd>
    </button>
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

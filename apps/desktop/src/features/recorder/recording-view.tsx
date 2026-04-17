/**
 * Recording view orchestrator (UI-04): TCC preflight → display picker →
 * Record button → status stage + step progress + cursor trail.
 *
 * Layout follows the "industrial recorder" research:
 *   ┌─────────────────────────────────────────────┐
 *   │ Header: [<] project name                    │
 *   │ [Permission banner — inline, not modal]     │
 *   ├───────────────────────────┬─────────────────┤
 *   │                           │ Source          │
 *   │       PREVIEW / STAGE     │ Quality         │
 *   │       (16:9 letterbox)    │ Options         │
 *   │                           │                 │
 *   ├───────────────────────────┴─────────────────┤
 *   │ Step rail (horizontal chips)                │
 *   ├─────────────────────────────────────────────┤
 *   │           [ ● Start Recording ]  ⌘R         │
 *   └─────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Loader2,
  Monitor,
  Pause as PauseIcon,
  Play as PlayIcon,
  Square as StopIcon,
  Settings as SettingsIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";

import {
  checkScreenCapturePermission,
  listDisplays,
  openScreenCapturePrefs,
  relaunchApp,
  requestScreenCaptureAccess,
  type DisplayInfo,
  type PermissionState,
} from "@/ipc/capture";
import { TargetPicker } from "@/features/capture/TargetPicker";
import {
  startRecording,
  stopRecording,
  type RecordingEvent,
  type RecordingSessionId,
} from "@/ipc/encode";
import { launchAutomation, type ExecutorEvent } from "@/ipc/automation";
import { parseStory } from "@/ipc/parse";
import {
  useRecorderStore,
  type RecorderStatus,
  type StepProgress,
} from "@/state/recorder";

import { TccPrompt } from "./tcc-prompt";
import { CursorTrail } from "./cursor-trail";

interface RecordingViewProps {
  projectId: string | null;
  projectName: string;
  projectFolder: string;
  storySource: string;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/** Format any Tauri IPC error into a human-readable string.
 *  Tauri serializes Rust `AppError` variants as JSON objects, which
 *  `String(e)` renders as the useless `"[object Object]"`. */
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

export function RecordingView({
  projectId,
  projectName,
  projectFolder,
  storySource,
}: RecordingViewProps) {
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
    refreshPlaywrightAvailability,
  } = useRecorderStore();

  const reduceMotion = useReducedMotion();
  const [permission, setPermission] = useState<PermissionState>("undetermined");
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [tccOpen, setTccOpen] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const [useCountdown, setUseCountdown] = useState(true);

  const sessionRef = useRef<RecordingSessionId | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const currentStepEntry =
    steps.length > 0 ? steps[Math.min(currentStep, steps.length - 1)] : null;
  const completedSteps = steps.filter((s) => s.status === "succeeded").length;
  const displayLabel = useMemo(() => {
    if (selectedDisplay == null) return null;
    const match = displays.find((d) => {
      const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
      return id === selectedDisplay;
    });
    return match ? `${match.name} · ${match.width_px}×${match.height_px}` : null;
  }, [displays, selectedDisplay]);

  // Preflight + display enumeration on mount.
  useEffect(() => {
    (async () => {
      try {
        let perm = await checkScreenCapturePermission();
        // If not granted, fire CGRequestScreenCaptureAccess. This registers
        // the app in System Settings → Privacy → Screen Recording so the
        // user has something to toggle. Without it, the app never appears
        // in the list.
        if (perm !== "granted") {
          perm = await requestScreenCaptureAccess();
        }
        setPermission(perm);
        // We intentionally do NOT auto-open the TccPrompt modal here —
        // Sequoia 15.1+ can false-negative the preflight even after the
        // user has granted. The inline banner (with "Already granted"
        // bypass) is less intrusive.
        if (perm === "granted") {
          try {
            const list = await listDisplays();
            setDisplays(list);
            if (list.length > 0) {
              const first = list[0].id;
              setSelectedDisplay(
                typeof first === "bigint" ? Number(first) : first,
              );
            }
          } catch (e) {
            setError(`listDisplays failed: ${formatIpcError(e)}`);
          }
          // Plan 05-01 — load capture targets + persisted selection.
          try {
            await loadCaptureTargets();
          } catch (e) {
            // Non-fatal; UI falls back to the legacy Display dropdown.
            // eslint-disable-next-line no-console
            console.warn("loadCaptureTargets failed:", e);
          }
        }
      } catch (e) {
        setError(formatIpcError(e));
      }
    })();
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive steps from story so rail is meaningful before capture starts.
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

  const dispatch = (event: RecordingEvent) => {
    switch (event.kind) {
      case "StepStarted":
        advanceStep(event.index, "running");
        break;
      case "StepSucceeded":
        advanceStep(event.index, "succeeded");
        if (
          typeof event.cursor_x === "number" &&
          typeof event.cursor_y === "number"
        ) {
          pushCursor({ x: event.cursor_x, y: event.cursor_y, t: Date.now() });
        }
        break;
      case "StepFailed":
        advanceStep(event.index, "failed");
        break;
      case "Completed":
        setStatus("completed");
        setOutputPath(event.result.output_path);
        toast.success("Recording complete", { description: event.result.output_path });
        break;
      case "Failed":
        setStatus("failed");
        setError(event.message);
        toast.error(`Recording failed: ${event.message}`);
        break;
      default:
        break;
    }
  };

  const handleRecord = async () => {
    if (permission !== "granted" || selectedDisplay == null) return;
    setStatus("recording");
    startedAtRef.current = Date.now();
    // Encoder must be told the *actual* pixel dimensions xcap delivers.
    // A mismatch produces noise because FFmpeg slices the raw BGRA byte
    // stream at the wrong frame boundaries. We take what the backend
    // reports for this display (already in physical pixels).
    const display = displays.find((d) => {
      const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
      return id === selectedDisplay;
    });
    const width = display?.width_px ?? 1920;
    const height = display?.height_px ?? 1080;
    try {
      const id = await startRecording(
        {
          project_folder: projectFolder,
          display_id: selectedDisplay,
          width,
          height,
          fps: 30,
        },
        (event) => dispatch(event),
      );
      sessionRef.current = id;
      setSession(
        typeof (id as unknown) === "string"
          ? (id as unknown as string)
          : id.id,
      );

      // Fire-and-forget: run the DSL against the browser driver in parallel
      // with the screen capture. Events update the step rail via dispatchAutomation.
      launchAutomation(
        { storySource, projectFolder },
        (evt) => dispatchAutomation(evt),
      ).catch((e) => {
        const msg = formatIpcError(e);
        toast.error(`Automation failed: ${msg}`);
        setError(msg);
      });
      // Plan 05-02: poll for Playwright window availability for up to 10s.
      // The host's background probe stashes the pid once Playwright's
      // launch() completes; this loop surfaces that to the UI and may
      // auto-pre-select the "Playwright browser (auto)" target if the
      // user hasn't made a non-auto choice this session.
      (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 800));
          await refreshPlaywrightAvailability();
        }
      })();
    } catch (e) {
      setError(formatIpcError(e));
      setStatus("failed");
      toast.error(`Recording failed to start: ${formatIpcError(e)}`);
    }
  };

  // Map automation executor events onto the step rail. `ordinal` is 1-based
  // in the Rust executor; the rail uses 0-based indices.
  const dispatchAutomation = (evt: ExecutorEvent) => {
    switch (evt.type) {
      case "step_started":
        advanceStep(evt.ordinal - 1, "running");
        break;
      case "step_succeeded":
        advanceStep(evt.ordinal - 1, "succeeded");
        pushCursor({ x: evt.cursor_x, y: evt.cursor_y, t: Date.now() });
        break;
      case "step_failed":
        advanceStep(evt.ordinal - 1, "failed");
        toast.error(`Step ${evt.ordinal} failed: ${evt.error_message}`);
        break;
      case "story_ended":
        if (evt.status.failed > 0) {
          toast.warning(`Story finished with ${evt.status.failed} failure(s)`);
        }
        // Auto-stop capture now that the DSL has finished executing.
        // Small delay to let the last frame land in the encoder buffer.
        window.setTimeout(() => {
          if (sessionRef.current) void handleStop();
        }, 500);
        break;
      default:
        break;
    }
  };

  const handleStop = async () => {
    if (!sessionRef.current) return;
    setStatus("stopping");
    try {
      await stopRecording(sessionRef.current, () => {});
    } catch (e) {
      toast.error(`Stop failed: ${formatIpcError(e)}`);
    }
  };

  // ⌘R / Ctrl+R to start/stop recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        if (status === "idle") void handleRecord();
        else if (status === "recording") void handleStop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, permission, selectedDisplay]);

  const canRecord = permission === "granted" && selectedDisplay != null;
  const permissionDenied = permission === "denied";
  const permissionPending = permission === "undetermined";

  return (
    <main
      id="main-content"
      className="relative flex h-full flex-col bg-[var(--color-bg-primary)]"
    >
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
            <span className="font-medium text-[var(--color-fg-primary)]">
              {projectName}
            </span>
            <span>/</span>
            <span>Record</span>
          </div>
          {status === "recording" && (
            <LiveRecordingBadge reduceMotion={!!reduceMotion} />
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-fg-muted)]">
          {sessionId ? (
            <span className="font-mono">
              session · {sessionId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      </header>

      {/* ─── Permission banner (inline, not modal) ─── */}
      {permissionDenied || permissionPending ? (
        <PermissionBanner
          state={permission}
          onOpenSettings={async () => {
            // Register the app in TCC first — this makes it appear in the
            // Screen Recording list in System Settings so the user has
            // something to toggle on.
            try {
              await requestScreenCaptureAccess();
            } catch {
              /* non-fatal; still open Settings */
            }
            openScreenCapturePrefs().catch(() => {});
            // Also pop the guided dialog for first-time onboarding.
            setTccOpen(true);
          }}
          onRelaunch={() => {
            relaunchApp().catch(() => {});
          }}
          onRecheck={async () => {
            const next = await checkScreenCapturePermission();
            setPermission(next);
            if (next === "granted") {
              const list = await listDisplays();
              setDisplays(list);
              if (list.length > 0) {
                const first = list[0].id;
                setSelectedDisplay(
                  typeof first === "bigint" ? Number(first) : first,
                );
              }
              toast.success("Screen recording permission granted");
            } else {
              toast.message(
                "Permission still needed",
                {
                  description:
                    "After granting in System Settings, relaunch StoryCapture so macOS picks up the change.",
                },
              );
            }
          }}
          onBypass={async () => {
            // Sequoia 15.1+ workaround: CGPreflightScreenCaptureAccess can
            // return false even when permission IS granted. Let the user
            // override — if they're wrong, recording will fail loudly.
            setPermission("granted");
            setTccOpen(false);
            try {
              const list = await listDisplays();
              setDisplays(list);
              if (list.length > 0) {
                const first = list[0].id;
                setSelectedDisplay(
                  typeof first === "bigint" ? Number(first) : first,
                );
              }
              toast.success("Permission check bypassed");
            } catch (e) {
              toast.error(`Could not list displays: ${formatIpcError(e)}`);
            }
          }}
        />
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
            <StepRail
              steps={steps}
              currentStep={currentStep}
              completedSteps={completedSteps}
            />
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
              ) : status === "completed" ? (
                <span className="text-[var(--color-success)]">
                  Recording complete
                </span>
              ) : status === "failed" ? (
                <span className="text-[var(--color-danger)]">
                  Recording failed
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {status === "idle" && (
                <RecordButton disabled={!canRecord} onClick={handleRecord} />
              )}
              {(status === "recording" || status === "paused") && (
                <>
                  <button
                    onClick={() =>
                      setStatus(status === "paused" ? "recording" : "paused")
                    }
                    aria-label={
                      status === "paused" ? "Resume recording" : "Pause recording"
                    }
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-xs text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-300)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    {status === "paused" ? (
                      <PlayIcon size={13} aria-hidden="true" />
                    ) : (
                      <PauseIcon size={13} aria-hidden="true" />
                    )}
                    {status === "paused" ? "Resume" : "Pause"}
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
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto bg-[var(--color-surface-100)] px-4 py-4">
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
                // Bridge to the legacy Display picker — when the user
                // selects a Display target, keep the encoder's old
                // display_id path working.
                if (t.kind === "display") {
                  const id =
                    typeof t.display_id === "bigint"
                      ? Number(t.display_id)
                      : t.display_id;
                  setSelectedDisplay(id);
                }
              }}
              onRefresh={() => loadCaptureTargets()}
              disabled={!canRecord || status !== "idle"}
            />
            {displayLabel && (
              <p className="mt-1.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                {displayLabel}
              </p>
            )}
          </SettingsGroup>

          <SettingsGroup label="Quality" icon={<SettingsIcon size={13} />}>
            <dl className="space-y-1 text-xs">
              <SettingsRow k="Resolution" v="1920×1080" />
              <SettingsRow k="Frame rate" v="30 fps" />
              <SettingsRow k="Codec" v="H.264" />
            </dl>
          </SettingsGroup>

          <SettingsGroup label="Options">
            <div className="space-y-2 text-xs">
              <Toggle
                label="Show cursor"
                checked={showCursor}
                onChange={setShowCursor}
              />
              <Toggle
                label="3s countdown"
                checked={useCountdown}
                onChange={setUseCountdown}
              />
            </div>
          </SettingsGroup>

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
        onDismiss={() => setTccOpen(false)}
      />
    </main>
  );
}

/* ─── Subcomponents ─── */

function LiveRecordingBadge({ reduceMotion }: { reduceMotion: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-danger)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--color-danger)]">
      <motion.span
        className="h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]"
        animate={reduceMotion ? undefined : { opacity: [1, 0.35, 1] }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      Live
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
          {isDenied
            ? "Screen recording permission denied."
            : "Screen recording permission needed."}
        </span>
        <span className="text-[var(--color-fg-secondary)]">
          macOS Sequoia sometimes reports stale state. If you've already granted,
          click "Already granted".
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
              <Monitor
                size={22}
                className="text-[var(--color-fg-muted)]"
                aria-hidden="true"
              />
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
              <span>Step {Math.min(currentStepIndex + 1, totalSteps)}</span>
              <span>/</span>
              <span>{totalSteps}</span>
            </div>
            <p className="font-mono mt-2 max-w-md truncate text-xs text-[var(--color-fg-secondary)]">
              {currentStepLabel ?? "waiting…"}
            </p>
            {status === "paused" && (
              <div className="mt-4 rounded-full bg-[var(--color-warning)]/15 px-3 py-1 text-[11px] font-medium text-[var(--color-warning)]">
                Paused
              </div>
            )}
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
            <AlertTriangle
              size={26}
              className="text-[var(--color-danger)]"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-medium text-[var(--color-fg-primary)]">
              Recording failed
            </p>
            <p className="font-mono mt-1 text-[11px] text-[var(--color-fg-secondary)]">
              {error}
            </p>
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

  return (
    <div className="flex items-center gap-3">
      <div className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
        {completedSteps} / {steps.length}
      </div>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {steps.map((step, i) => {
          const active = i === currentStep;
          const done = step.status === "succeeded";
          const running = step.status === "running";
          const failed = step.status === "failed";
          return (
            <motion.div
              key={i}
              layout
              className={`flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] font-medium ${
                failed
                  ? "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
                  : done
                    ? "bg-[var(--color-success)]/10 text-[var(--color-success)]"
                    : running || active
                      ? "bg-[var(--color-accent-primary)]/10 text-[var(--color-accent-primary)]"
                      : "bg-[var(--color-surface-300)] text-[var(--color-fg-muted)]"
              }`}
            >
              {done ? (
                <CheckCircle2 size={10} aria-hidden="true" />
              ) : running ? (
                <Loader2
                  size={10}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : failed ? (
                <AlertTriangle size={10} aria-hidden="true" />
              ) : (
                <Circle size={10} aria-hidden="true" />
              )}
              <span className="font-mono tabular-nums">{i + 1}</span>
              <span className="truncate">{step.verb}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function RecordButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
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
      <dd className="font-mono text-[11px] text-[var(--color-fg-primary)]">
        {v}
      </dd>
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
          checked
            ? "bg-[var(--color-accent-primary)]"
            : "bg-[var(--color-surface-400)]"
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

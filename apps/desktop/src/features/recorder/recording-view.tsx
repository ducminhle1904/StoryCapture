/**
 * Recording view orchestrator (UI-04): TCC preflight → display picker →
 * Record button → status stage + step progress + cursor trail.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Monitor,
  Pause as PauseIcon,
  Play as PlayIcon,
  Square as StopIcon,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import {
  checkScreenCapturePermission,
  listDisplays,
  type DisplayInfo,
  type PermissionState,
} from "@/ipc/capture";
import {
  startRecording,
  stopRecording,
  type RecordingEvent,
  type RecordingSessionId,
} from "@/ipc/encode";
import { parseStory } from "@/ipc/parse";
import { useRecorderStore } from "@/state/recorder";

import { TccPrompt } from "./tcc-prompt";
import { StepProgress } from "./step-progress";
import { CursorTrail } from "./cursor-trail";

interface RecordingViewProps {
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

function formatPermission(state: PermissionState) {
  switch (state) {
    case "Granted":
      return {
        label: "Granted",
        tone: "text-[var(--color-success)]",
        dot: "bg-[var(--color-success)]",
      };
    case "Denied":
      return {
        label: "Needs attention",
        tone: "text-[var(--color-danger)]",
        dot: "bg-[var(--color-danger)]",
      };
    default:
      return {
        label: "Pending",
        tone: "text-[var(--color-warning)]",
        dot: "bg-[var(--color-warning)]",
      };
  }
}

export function RecordingView({
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
    setStatus,
    setSession,
    setSteps,
    advanceStep,
    pushCursor,
    setError,
    setOutputPath,
    setElapsed,
    reset,
  } = useRecorderStore();

  const [permission, setPermission] = useState<PermissionState>("Undetermined");
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  const [tccOpen, setTccOpen] = useState(false);

  const sessionRef = useRef<RecordingSessionId | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const currentStepEntry =
    steps.length > 0 ? steps[Math.min(currentStep, steps.length - 1)] : null;
  const completedSteps = steps.filter((step) => step.status === "succeeded").length;
  const displayLabel = useMemo(() => {
    if (selectedDisplay == null) return "No display selected";
    const match = displays.find((d) => {
      const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
      return id === selectedDisplay;
    });
    return match ? `${match.name} · ${match.width}×${match.height}` : "Selected display";
  }, [displays, selectedDisplay]);

  // Preflight + display enumeration on mount.
  useEffect(() => {
    (async () => {
      try {
        const perm = await checkScreenCapturePermission();
        setPermission(perm);
        if (perm !== "Granted") {
          setTccOpen(true);
        } else {
          const list = await listDisplays();
          setDisplays(list);
          if (list.length > 0) {
            const first = list[0].id;
            setSelectedDisplay(typeof first === "bigint" ? Number(first) : first);
          }
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive recorder steps from the story so progress is meaningful before capture starts.
  useEffect(() => {
    let cancelled = false;
    parseStory(storySource)
      .then((result) => {
        if (cancelled || !result.ast) return;
        const derivedSteps = result.ast.scenes.flatMap((scene) =>
          scene.commands.map((command, index) => ({
            index,
            status: "pending" as const,
            verb: command.verb,
          })),
        );
        setSteps(derivedSteps);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [setSteps, storySource]);

  // Timer for elapsed display.
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
        setOutputPath(event.output_path);
        toast.success("Recording complete", {
          description: event.output_path,
        });
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
    if (permission !== "Granted" || selectedDisplay == null) return;
    setStatus("recording");
    startedAtRef.current = Date.now();
    try {
      const id = await startRecording(
        {
          project_folder: projectFolder,
          display_id: selectedDisplay,
          width: 1920,
          height: 1080,
          fps: 30,
        },
        (event) => dispatch(event),
      );
      sessionRef.current = id;
      setSession(typeof (id as unknown) === "string" ? (id as unknown as string) : id.id);
    } catch (e) {
      setError(String(e));
      setStatus("failed");
      toast.error(`Recording failed to start: ${String(e)}`);
    }
    void storySource;
  };

  const handleStop = async () => {
    if (!sessionRef.current) return;
    setStatus("stopping");
    try {
      await stopRecording(sessionRef.current);
    } catch (e) {
      toast.error(`Stop failed: ${String(e)}`);
    }
  };

  const permissionVisual = formatPermission(permission);

  return (
    <main
      id="main-content"
      className="relative flex h-full flex-col bg-[var(--color-bg-primary)]"
    >
      <CursorTrail />

      <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-300)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-sm font-medium text-[var(--color-fg-primary)]">
              {projectName}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
              <span>recording control</span>
              {sessionId ? <span>session: {sessionId.slice(0, 8)}</span> : null}
            </div>
          </div>
        </div>
        <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
          target identity
          <span className="ml-2 text-[var(--color-fg-primary)]">{displayLabel}</span>
        </div>
      </header>

      <section className="grid min-h-0 flex-1 gap-6 px-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col justify-between rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-5 shadow-[var(--shadow-card)]">
          <div className="space-y-8">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                Permissions state
              </div>
              <div className="mt-4 space-y-2">
                <PermissionRow
                  label="Screen capture"
                  value={permissionVisual.label}
                  tone={permissionVisual.tone}
                  dotClassName={permissionVisual.dot}
                />
                <PermissionRow
                  label="Audio input"
                  value="Ready"
                  tone="text-[var(--color-success)]"
                  dotClassName="bg-[var(--color-success)]"
                />
                <PermissionRow
                  label="System events"
                  value={steps.length > 0 ? "Script loaded" : "Waiting"}
                  tone={steps.length > 0 ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}
                  dotClassName={
                    steps.length > 0
                      ? "bg-[var(--color-success)]"
                      : "bg-[var(--color-warning)]"
                  }
                />
              </div>
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                Session statistics
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <StatCard label="Steps ready" value={String(steps.length)} />
                <StatCard label="Completed" value={String(completedSteps)} />
                <StatCard label="Buffer" value="128MB" />
                <StatCard label="FPS" value="30" />
              </div>
            </div>
          </div>

          <div className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
              Capture target
            </div>
            <label
              htmlFor="display-select"
              className="mt-3 block text-sm text-[var(--color-fg-secondary)]"
            >
              Display
            </label>
            <div className="relative mt-2">
              <Monitor
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-muted)]"
              />
              <select
                id="display-select"
                value={selectedDisplay ?? ""}
                onChange={(e) => setSelectedDisplay(Number(e.target.value))}
                disabled={permission !== "Granted" || displays.length === 0}
                className="min-w-0 w-full rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-500)] py-2 pl-9 pr-3 text-sm text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
              >
                {displays.length === 0 && <option value="">No displays detected</option>}
                {displays.map((d) => {
                  const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
                  return (
                    <option key={String(id)} value={id}>
                      {d.name} — {d.width}×{d.height}
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 flex-col gap-5">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)]">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] px-6 py-5">
              <div>
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
                  Recording control
                  {status === "recording" ? (
                    <span className="rounded-full bg-[var(--color-danger)]/18 px-2 py-0.5 text-[var(--color-danger)]">
                      live session
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-fg-secondary)]">
                  {status === "idle"
                    ? "Prepare the capture target, confirm permissions, then start the automated run."
                    : "Actively capturing the scripted sequence. System state stays visible while the browser run advances."}
                </p>
              </div>
              <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
                {projectFolder.split("/").slice(-2).join("/")}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col justify-between px-6 py-6">
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="relative flex min-h-[420px] w-full max-w-5xl flex-col justify-center overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-6 py-8 shadow-[inset_0_1px_0_rgba(38,37,30,0.03)]">
                  <div className="pointer-events-none absolute inset-0 opacity-35 [background-image:radial-gradient(rgba(38,37,30,0.06)_1px,transparent_1px)] [background-size:18px_18px]" />
                  <div className="pointer-events-none absolute inset-x-10 top-10 h-56 rounded-full bg-[radial-gradient(circle,rgba(255,107,115,0.08),transparent_60%)] blur-3xl" />

                  <div className="relative text-center">
                    <div className="font-mono text-[clamp(3rem,8vw,5.5rem)] font-semibold tracking-[-0.06em] text-[var(--color-fg-primary)]">
                      {formatTime(elapsedMs)}
                    </div>
                    <div className="mt-4 text-[12px] uppercase tracking-[0.34em] text-[var(--color-accent-primary)]">
                      Current step:
                      <span className="ml-3 text-[var(--color-fg-secondary)]">
                        {currentStepEntry?.verb ?? "waiting"}
                      </span>
                    </div>
                    {error ? (
                      <div className="mx-auto mt-5 max-w-xl rounded-2xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]">
                        {error}
                      </div>
                    ) : null}
                    {status === "completed" && outputPath ? (
                      <div className="mx-auto mt-5 max-w-xl rounded-2xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 px-4 py-3 text-sm text-[var(--color-success)]">
                        Saved to {outputPath}
                      </div>
                    ) : null}
                  </div>

                  <div className="relative mt-8">
                    <StepProgress />
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
                {status === "idle" && (
                  <button
                    onClick={handleRecord}
                    disabled={permission !== "Granted" || selectedDisplay == null}
                    aria-label="Start recording"
                    className="inline-flex items-center gap-2 rounded-2xl bg-[var(--color-danger)] px-6 py-3 text-sm font-medium text-[var(--color-fg-primary)] shadow-[0_16px_36px_rgba(255,107,115,0.22)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
                  >
                    <Video size={18} aria-hidden="true" />
                    Start recording
                  </button>
                )}

                {(status === "recording" || status === "paused") && (
                  <>
                    <button
                      onClick={() =>
                        setStatus(status === "paused" ? "recording" : "paused")
                      }
                      aria-label={
                        status === "paused"
                          ? "Resume recording"
                          : "Pause recording"
                      }
                      className="inline-flex items-center gap-2 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-5 py-3 text-sm text-[var(--color-fg-primary)] transition hover:bg-[var(--color-surface-300)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                    >
                      {status === "paused" ? (
                        <PlayIcon size={16} aria-hidden="true" />
                      ) : (
                        <PauseIcon size={16} aria-hidden="true" />
                      )}
                      {status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      onClick={handleStop}
                      aria-label="Stop recording"
                      className="inline-flex items-center gap-2 rounded-2xl bg-[var(--color-danger)] px-5 py-3 text-sm font-medium text-[var(--color-fg-primary)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
                    >
                      <StopIcon size={16} aria-hidden="true" />
                      Stop
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>

      <TccPrompt
        open={tccOpen}
        permission={permission}
        onDismiss={() => setTccOpen(false)}
      />
    </main>
  );
}

function PermissionRow({
  label,
  value,
  tone,
  dotClassName,
}: {
  label: string;
  value: string;
  tone: string;
  dotClassName: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-3 py-3">
      <span className="text-sm text-[var(--color-fg-secondary)]">{label}</span>
      <span className={`inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] ${tone}`}>
        <span className={`h-2 w-2 rounded-full ${dotClassName}`} />
        {value}
      </span>
    </div>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl text-[var(--color-fg-primary)]">
        {value}
      </div>
    </div>
  );
}

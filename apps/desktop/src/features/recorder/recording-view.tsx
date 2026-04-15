/**
 * Recording view orchestrator (UI-04): TCC preflight → display picker →
 * Record button → HUD + StepProgress + CursorTrail. Subscribes to a Tauri
 * `Channel<RecordingEvent>` from `start_recording` and dispatches to the
 * recorder Zustand store.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Video,
  Square as StopIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
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
import { useRecorderStore } from "@/state/recorder";

import { TccPrompt } from "./tcc-prompt";
import { RecordingHud } from "./hud";
import { StepProgress } from "./step-progress";
import { CursorTrail } from "./cursor-trail";

interface RecordingViewProps {
  projectName: string;
  projectFolder: string;
  storySource: string;
}

export function RecordingView({
  projectName,
  projectFolder,
  storySource,
}: RecordingViewProps) {
  const {
    status,
    setStatus,
    setSession,
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

  // Timer for HUD elapsed display.
  useEffect(() => {
    if (status !== "recording") return;
    const handle = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Date.now() - startedAtRef.current);
      }
    }, 250);
    return () => window.clearInterval(handle);
  }, [status, setElapsed]);

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
    // Pass storySource upstream so automation can execute the DSL alongside
    // capture. Phase 1: source is visible in audit logs; Plan 06 owns the
    // actual executor wiring. This is currently a no-op placeholder.
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
          action: {
            label: "Open",
            onClick: () => {
              /* tauri-plugin-opener hookup deferred to next plan */
            },
          },
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

  return (
    <main id="main-content" className="relative flex h-screen flex-col">
      <CursorTrail />
      <RecordingHud projectName={projectName} />

      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            aria-label="Back to dashboard"
            className="inline-flex items-center gap-1 rounded-md p-1 text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <h1 className="text-sm font-medium text-[var(--color-fg-primary)]">
            {projectName} — Recorder
          </h1>
        </div>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        {status === "idle" && (
          <>
            <div className="flex flex-col gap-2 items-center">
              <label htmlFor="display-select" className="text-sm text-[var(--color-fg-secondary)]">
                Display
              </label>
              <select
                id="display-select"
                value={selectedDisplay ?? ""}
                onChange={(e) => setSelectedDisplay(Number(e.target.value))}
                disabled={permission !== "Granted" || displays.length === 0}
                className="min-w-[260px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-sm text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
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
            <button
              onClick={handleRecord}
              disabled={permission !== "Granted" || selectedDisplay == null}
              aria-label="Start recording"
              className="inline-flex items-center gap-2 rounded-full bg-[var(--color-danger)] px-6 py-3 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
            >
              <Video size={18} aria-hidden="true" />
              Record
            </button>
          </>
        )}

        {(status === "recording" || status === "paused") && (
          <div className="flex flex-col items-stretch gap-4 w-full max-w-2xl">
            <StepProgress />
            <div className="flex justify-center gap-3">
              <button
                onClick={() => setStatus(status === "paused" ? "recording" : "paused")}
                aria-label={status === "paused" ? "Resume recording" : "Pause recording"}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-2 text-sm text-[var(--color-fg-primary)] hover:bg-[var(--color-bg-elevated)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
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
                className="inline-flex items-center gap-2 rounded-md bg-[var(--color-danger)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                <StopIcon size={16} aria-hidden="true" />
                Stop
              </button>
            </div>
          </div>
        )}

        {status === "completed" && (
          <div
            role="status"
            className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-6 text-center text-sm text-[var(--color-fg-primary)]"
          >
            <p className="font-medium text-[var(--color-success)]">Recording complete</p>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Saved to project exports folder.
            </p>
          </div>
        )}
      </section>

      <TccPrompt
        open={tccOpen}
        permission={permission}
        onDismiss={() => setTccOpen(false)}
      />
    </main>
  );
}

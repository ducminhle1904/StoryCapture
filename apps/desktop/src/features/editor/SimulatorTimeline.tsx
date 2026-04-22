import { AlertTriangle, ArrowUpRight, Copy, Play, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  simulatorCancel,
  simulatorPromoteFallback,
  simulatorStart,
  type SimulatorStepFrame,
} from "@/ipc/simulator";
import { useSimulatorStore } from "@/state/simulatorStore";

interface SimulatorTimelineProps {
  projectFolder: string;
  storyPath: string;
  storySource: string;
  streamId: string | null;
  previewEnabled: boolean;
}

export function SimulatorTimeline({
  projectFolder,
  storyPath,
  storySource,
  streamId,
  previewEnabled,
}: SimulatorTimelineProps) {
  const frames = useSimulatorStore((s) => s.frames);
  const runState = useSimulatorStore((s) => s.runState);
  const totalSteps = useSimulatorStore((s) => s.totalSteps);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const error = useSimulatorStore((s) => s.error);
  const currentOrd = useSimulatorStore((s) => s.currentFrameOrdinal);
  const dismissedHint = useSimulatorStore((s) => s.dismissedCoexistenceHint);
  const setCurrent = useSimulatorStore((s) => s.setCurrentFrameOrdinal);
  const dismissHint = useSimulatorStore((s) => s.dismissCoexistenceHint);

  const isRunning = runState === "running";
  const isFailed = runState === "failed";
  const active = useMemo(
    () => (currentOrd != null ? frames.find((f) => f.ordinal === currentOrd) ?? null : null),
    [frames, currentOrd],
  );
  const totalDuration = useMemo(
    () => frames.reduce((acc, f) => acc + f.duration_ms, 0),
    [frames],
  );

  const canRun = previewEnabled && streamId != null;

  const handleRun = async () => {
    if (!canRun) return;
    try {
      await simulatorStart(
        {
          projectFolder,
          storySource,
          storyPath,
          streamId: streamId!,
          stopAfterOrdinal: undefined,
        },
        (e) => useSimulatorStore.getState().handleEvent(e),
      );
    } catch (err) {
      toast.error(`Could not start simulator: ${String(err)}`);
    }
  };

  const handleCancel = async () => {
    if (!sessionId) return;
    try {
      await simulatorCancel(sessionId);
    } catch (err) {
      toast.error(`Cancel failed: ${String(err)}`);
    }
  };

  return (
    <section
      role="region"
      aria-labelledby="simulator-panel-title"
      className="flex flex-col overflow-hidden border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]"
      style={{ minHeight: 128, maxHeight: "30vh" }}
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <h3
          id="simulator-panel-title"
          className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]"
        >
          Simulator
        </h3>
        <div className="flex items-center gap-3">
          {frames.length > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
              Step {currentOrd ?? "—"} / {totalSteps} · {totalDuration} ms
            </span>
          )}
          {isRunning ? (
            <button
              type="button"
              onClick={handleCancel}
              aria-label="Cancel simulator run"
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-300)] px-2 py-1 text-xs font-medium text-[var(--color-fg-primary)] hover:bg-[var(--color-danger)]/12"
            >
              <X size={12} aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRun}
              disabled={!canRun}
              aria-label="Run simulator"
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-300)] px-2 py-1 text-xs font-medium text-[var(--color-fg-primary)] hover:bg-[var(--color-accent-primary)]/12 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play size={12} aria-hidden="true" />
              Run simulator
            </button>
          )}
        </div>
      </header>

      {!previewEnabled && (
        <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-2 text-[11px] text-[var(--color-fg-muted)]">
          Preview is off. Turn on Preview in the Editor header to run the simulator.
        </div>
      )}

      {frames.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex flex-1 flex-shrink-0 gap-2 overflow-x-auto overflow-y-hidden px-3 py-2">
            {frames.map((f) => (
              <FrameCard
                key={f.ordinal}
                frame={f}
                isActive={f.ordinal === currentOrd}
                isFailed={isFailed && f.ordinal === currentOrd}
                onClick={() => setCurrent(f.ordinal)}
                onPromote={async () => {
                  if (!sessionId) return;
                  try {
                    await simulatorPromoteFallback(sessionId, f.ordinal);
                    toast.success(
                      `Fallback added to .story.targets.json for step ${f.ordinal}.`,
                    );
                  } catch (err) {
                    toast.error(
                      `Could not write fallback. Check file permissions and try again. (${String(err)})`,
                    );
                  }
                }}
              />
            ))}
          </div>

          <div className="flex items-center gap-3 border-t border-[var(--color-border-subtle)] px-3 py-1.5">
            <input
              type="range"
              min={1}
              max={Math.max(1, frames.length)}
              value={currentOrd ?? 1}
              aria-label="Simulator frame scrubber"
              aria-valuemin={1}
              aria-valuemax={frames.length}
              aria-valuenow={currentOrd ?? 1}
              onChange={(e) => setCurrent(parseInt(e.target.value, 10))}
              className="flex-1 accent-[var(--color-accent-primary)]"
            />
            {active && (
              <span
                className="font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]"
                title="Click selector to copy"
              >
                Step {active.ordinal} · {active.duration_ms} ms
              </span>
            )}
          </div>

          {active && active.matched_selector && (
            <div className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-3 py-1.5 text-[10px] text-[var(--color-fg-muted)]">
              <span className="font-mono">selector:</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(active.matched_selector ?? "");
                  toast.success("Selector copied");
                }}
                className="truncate font-mono text-[var(--color-fg-primary)] hover:text-[var(--color-accent-primary)]"
                aria-label="Copy matched selector"
              >
                {active.matched_selector}
              </button>
            </div>
          )}
        </>
      )}

      {isFailed && (
        <div className="flex items-center gap-2 border-t border-[var(--color-danger)]/40 bg-[var(--color-danger)]/12 px-3 py-2 text-[11px] text-[var(--color-danger)]">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>
            Step {currentOrd ?? "?"}: {error ?? "selector not found"}
          </span>
          {active?.matched_selector && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(active.matched_selector ?? "");
                toast.success("Selector copied");
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1 py-0.5 hover:bg-[var(--color-danger)]/18"
              aria-label="Copy matched selector"
            >
              <Copy size={10} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {!dismissedHint && frames.length > 0 && (
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-1.5 text-[10px] text-[var(--color-fg-muted)]">
          <span>
            Simulator is the canonical author-time runner. Dry-Run (older) remains
            available during the transition.
          </span>
          <button
            type="button"
            onClick={dismissHint}
            className="text-[10px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
            aria-label="Dismiss Simulator vs Dry-Run hint"
          >
            dismiss
          </button>
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <p className="text-xs font-medium text-[var(--color-fg-primary)]">
        No simulator run yet
      </p>
      <p className="max-w-md text-[10px] text-[var(--color-fg-muted)]">
        Click Run simulator to replay your story without recording. Each step captures a
        screenshot, matched selector, and cursor position.
      </p>
    </div>
  );
}

interface FrameCardProps {
  frame: SimulatorStepFrame;
  isActive: boolean;
  isFailed: boolean;
  onClick: () => void;
  onPromote: () => void;
}

function FrameCard({ frame, isActive, isFailed, onClick, onPromote }: FrameCardProps) {
  const [promoted, setPromoted] = useState(false);
  const borderColor = isFailed
    ? "var(--color-danger)"
    : isActive
      ? "var(--color-accent-primary)"
      : frame.match_kind === "fuzzy"
        ? "var(--color-warning)"
        : "var(--color-border-subtle)";
  const borderStyle = frame.match_kind === "fuzzy" && !isActive && !isFailed ? "dashed" : "solid";
  const borderWidth = isActive || isFailed ? 2 : 1;

  return (
    <button
      type="button"
      role="button"
      aria-label={`Simulator frame ${frame.ordinal}`}
      aria-current={isActive ? "true" : undefined}
      onClick={onClick}
      className="relative flex flex-shrink-0 flex-col overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-200)] text-left"
      style={{ width: 80, height: 56, border: `${borderWidth}px ${borderStyle} ${borderColor}` }}
    >
      <span className="flex flex-1 items-center justify-center font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
        {String(frame.ordinal).padStart(2, "0")}
      </span>
      <span className="flex items-center justify-between px-1 py-0.5 text-[9px] uppercase tracking-[0.08em]">
        <MatchChip kind={frame.match_kind} />
        <span className="font-mono tabular-nums text-[var(--color-fg-muted)]">
          {frame.duration_ms}ms
        </span>
      </span>
      {isFailed && (
        <span className="pointer-events-none absolute right-0.5 top-0.5 text-[var(--color-danger)]">
          <AlertTriangle size={10} aria-hidden="true" />
        </span>
      )}
      {frame.match_kind === "fuzzy" && !promoted && (
        <span
          role="button"
          aria-label={`Promote matched selector for step ${frame.ordinal} to fallback`}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setPromoted(true);
            onPromote();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              setPromoted(true);
              onPromote();
            }
          }}
          className="absolute bottom-0.5 right-0.5 inline-flex h-4 w-4 items-center justify-center rounded-[var(--radius-xs)] bg-[var(--color-surface-300)] text-[var(--color-warning)] hover:bg-[var(--color-warning)]/18"
          title="Promote to fallback"
        >
          <ArrowUpRight size={9} aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

function MatchChip({ kind }: { kind: SimulatorStepFrame["match_kind"] }) {
  const tone =
    kind === "primary"
      ? { bg: "var(--color-success)", fg: "#fff", label: "matched" }
      : kind === "fuzzy"
        ? { bg: "var(--color-warning)", fg: "#1a1a1a", label: "fuzzy" }
        : { bg: "var(--color-timeline-read)", fg: "#1a1a1a", label: "none" };
  return (
    <span
      className="rounded-[var(--radius-xs)] px-1 py-px font-medium"
      style={{ background: tone.bg, color: tone.fg, fontSize: 8 }}
    >
      {tone.label}
    </span>
  );
}

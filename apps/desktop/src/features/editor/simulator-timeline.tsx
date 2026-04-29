import { AlertTriangle, ArrowUpRight, Copy, Crosshair, Loader2, Play, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { editorController } from "@/features/editor/controller";
import { triggerPickFromEditor } from "@/features/editor/PreviewPickerButton";
import { TARGET_VERBS } from "@/features/editor/picker-emit-rewrite";
import { verbIcon } from "@/features/editor/verb-icons";
import type { Command, SelectorOrText } from "@/ipc/parse";
import { simulatorCancel, simulatorPromoteFallback, simulatorStart } from "@/ipc/simulator";
import { frontendLog } from "@/lib/log";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

interface SimulatorTimelineProps {
  projectFolder: string;
  storyPath: string;
  storySource: string;
  streamId: string | null;
  appUrlValid: boolean;
}

function stringifySelectorOrText(s: SelectorOrText): string {
  switch (s.kind) {
    case "text":
      return `text: "${s.value}"`;
    case "selector":
      return s.value;
    case "test_id":
      return `test_id: ${s.value}`;
    case "aria":
      return `aria: ${s.value}`;
    case "role":
      return `${s.value.role}: "${s.value.name}"`;
    case "label":
      return `label: "${s.value}"`;
    case "text_exact":
      return `text: "${s.value}"`;
  }
}

function summarizeTarget(cmd: Command): string {
  switch (cmd.verb) {
    case "navigate":
      return cmd.url;
    case "click":
    case "hover":
    case "assert":
    case "wait-for":
      return stringifySelectorOrText(cmd.target);
    case "type":
      return `${stringifySelectorOrText(cmd.target)} ← "${cmd.text}"`;
    case "select":
      return `${stringifySelectorOrText(cmd.target)} = ${cmd.value}`;
    case "upload":
      return `${stringifySelectorOrText(cmd.target)} ← ${cmd.path}`;
    case "drag":
      return `${stringifySelectorOrText(cmd.from)} → ${stringifySelectorOrText(cmd.to)}`;
    case "scroll":
      return cmd.amount != null ? `${cmd.direction} ${cmd.amount}` : cmd.direction;
    case "wait":
      return `${cmd.duration_ms}ms`;
    case "screenshot":
      return cmd.name;
    case "pause":
      return "";
    default:
      return "";
  }
}

export function SimulatorTimeline({
  projectFolder,
  storyPath,
  storySource,
  streamId,
  appUrlValid,
}: SimulatorTimelineProps) {
  const frames = useSimulatorStore((s) => s.frames);
  const runState = useSimulatorStore((s) => s.runState);
  const totalSteps = useSimulatorStore((s) => s.totalSteps);
  const sessionId = useSimulatorStore((s) => s.sessionId);
  const error = useSimulatorStore((s) => s.error);
  const currentOrd = useSimulatorStore((s) => s.currentFrameOrdinal);
  const inFlightOrdinal = useSimulatorStore((s) => s.inFlightOrdinal);
  const inFlightStartedAt = useSimulatorStore((s) => s.inFlightStartedAt);
  const setCurrent = useSimulatorStore((s) => s.setCurrentFrameOrdinal);
  const ast = useEditorStore((s) => s.lastParse?.ast ?? null);

  const isRunning = runState === "running";
  const isFailed = runState === "failed";
  const active = currentOrd != null ? (frames[currentOrd - 1] ?? null) : null;
  const totalDuration = useMemo(() => frames.reduce((acc, f) => acc + f.duration_ms, 0), [frames]);

  // Tick once a second while a step is in flight so the elapsed-ms banner
  // updates without re-rendering the whole simulator on every frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (inFlightStartedAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inFlightStartedAt]);
  const inFlightElapsedMs = inFlightStartedAt != null ? Math.max(0, now - inFlightStartedAt) : 0;

  // Surface failures via toast so the user notices even if their attention is
  // on the editor or the live preview. Fire once per transition into "failed";
  // the ref guards against re-firing on currentOrd/error churn within the same
  // failed run.
  const lastFailedRunStateRef = useRef<string | null>(null);
  useEffect(() => {
    if (runState === "failed" && lastFailedRunStateRef.current !== "failed") {
      toast.error(`Step ${currentOrd ?? "?"} failed`, {
        description: error ?? "selector not found",
        duration: 8000,
      });
    }
    lastFailedRunStateRef.current = runState;
  }, [runState, currentOrd, error]);

  const commandByOrdinal = useMemo(() => {
    const map = new Map<number, Command>();
    if (!ast) return map;
    let ord = 0;
    for (const scene of ast.scenes) {
      for (const cmd of scene.commands) {
        ord += 1;
        map.set(ord, cmd);
      }
    }
    return map;
  }, [ast]);

  const canRun = appUrlValid && streamId != null;

  const handleRun = async () => {
    console.log("[sim] Run clicked", { canRun, appUrlValid, streamId, projectFolder, storyPath });
    if (!canRun || streamId == null) {
      console.log("[sim] Run aborted — canRun=false");
      return;
    }
    try {
      const sid = await simulatorStart(
        {
          projectFolder,
          storySource,
          storyPath,
          streamId,
          stopAfterOrdinal: undefined,
        },
        (e) => useSimulatorStore.getState().handleEvent(e),
      );
      frontendLog.info("simulatorTimeline", "simulatorStart resolved", {
        fields: { session_id: sid, project_folder: projectFolder, story_path: storyPath },
      });
    } catch (err) {
      frontendLog.error("simulatorTimeline", "simulatorStart threw", {
        error: err,
        fields: { project_folder: projectFolder, story_path: storyPath, stream_id: streamId },
      });
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err !== null
            ? ((err as { message?: string }).message ?? JSON.stringify(err))
            : String(err);
      toast.error(`Could not start simulator: ${msg}`);
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

  const handleStripKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (frames.length === 0) return;
    const cur = currentOrd ?? 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setCurrent(Math.max(1, cur - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setCurrent(Math.min(frames.length, cur + 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setCurrent(1);
    } else if (e.key === "End") {
      e.preventDefault();
      setCurrent(frames.length);
    }
  };

  const activeCmd = currentOrd != null ? (commandByOrdinal.get(currentOrd) ?? null) : null;

  const headerLabel = (() => {
    if (isRunning && inFlightOrdinal != null) {
      return `Running step ${inFlightOrdinal} / ${totalSteps}`;
    }
    if (frames.length > 0) {
      return `Step ${currentOrd ?? "—"} / ${totalSteps} · ${totalDuration} ms`;
    }
    if (isRunning) return "Preparing…";
    return "Idle";
  })();

  const inFlightCmd =
    isRunning && inFlightOrdinal != null ? (commandByOrdinal.get(inFlightOrdinal) ?? null) : null;
  const inFlightSummary = inFlightCmd
    ? ` · ${inFlightCmd.verb} ${summarizeTarget(inFlightCmd)}`
    : "";

  return (
    <section
      aria-labelledby="simulator-panel-title"
      className="flex flex-col overflow-hidden border-t border-[var(--sc-border-2)] bg-[var(--sc-surface)]"
      style={{ minHeight: 128, maxHeight: "30vh" }}
    >
      <header className="flex items-center justify-between border-b border-[var(--sc-border-2)] px-3 py-1.5">
        <h3 id="simulator-panel-title" className="sr-only">
          Simulator
        </h3>
        <span className="font-mono text-[10px] tabular-nums text-[var(--sc-text-3)]">
          {headerLabel}
        </span>
        <div className="flex items-center gap-3">
          {isRunning ? (
            <button
              type="button"
              onClick={handleCancel}
              aria-label="Cancel simulator run"
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-3)] px-2 py-1 text-xs font-medium text-[var(--sc-text)] hover:bg-[var(--sc-record)]/12 active:translate-y-[1px]"
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
              title={
                !appUrlValid
                  ? "Set meta.app in your story to enable the simulator"
                  : streamId == null
                    ? "Live Preview is starting — wait for the badge to read 'live'"
                    : undefined
              }
              className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold transition-colors active:translate-y-[1px] disabled:cursor-not-allowed ${
                canRun
                  ? "bg-[var(--sc-accent-500)] text-[var(--sc-text)] hover:bg-[var(--sc-accent-400)]"
                  : "border border-[var(--sc-border)] bg-[var(--sc-surface-3)] text-[var(--sc-text-3)] opacity-60"
              }`}
            >
              <Play size={12} aria-hidden="true" />
              Run simulator
            </button>
          )}
        </div>
      </header>

      {!appUrlValid && (
        <div className="border-b border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-3 py-2 text-[11px] text-[var(--sc-text-3)]">
          Set <code>meta.app</code> to run
        </div>
      )}

      {frames.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div
            role="listbox"
            aria-label="Simulator frames"
            tabIndex={0}
            onKeyDown={handleStripKeyDown}
            className="flex gap-[2px] overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--sc-surface-2)] p-1 focus:outline-none focus:ring-1 focus:ring-[var(--sc-accent-400)]"
          >
            <AnimatePresence initial={false}>
              {frames.map((f) => {
                const isActive = f.ordinal === currentOrd;
                const cmd = commandByOrdinal.get(f.ordinal) ?? null;
                const Icon = verbIcon(cmd?.verb ?? "");
                const stripeColor =
                  isFailed && f.ordinal === currentOrd
                    ? "var(--sc-record)"
                    : f.match_kind === "fuzzy"
                      ? "var(--sc-warn)"
                      : null;
                return (
                  <motion.button
                    key={f.ordinal}
                    layoutId={`sim-frame-${f.ordinal}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    aria-label={`Simulator frame ${f.ordinal}, ${f.duration_ms}ms, ${f.match_kind}`}
                    onClick={() => setCurrent(f.ordinal)}
                    transition={{ type: "spring", stiffness: 160, damping: 22 }}
                    className={`relative flex h-12 w-12 shrink-0 cursor-pointer flex-col items-center justify-between rounded-[var(--radius-xs)] py-1 text-[var(--sc-text-2)] transition-colors active:translate-y-[1px] ${
                      isActive ? "" : "hover:bg-[var(--sc-surface-4)]"
                    }`}
                    style={{
                      background: isActive
                        ? "color-mix(in oklch, var(--sc-accent-400) 14%, var(--sc-surface-3))"
                        : undefined,
                      outline: isActive
                        ? "1px solid color-mix(in oklch, var(--sc-accent-400) 55%, transparent)"
                        : undefined,
                      outlineOffset: 0,
                      borderBottom: stripeColor ? `2px solid ${stripeColor}` : undefined,
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="font-mono text-[9px] tabular-nums text-[var(--sc-text-3)]">
                      {totalSteps >= 10 ? String(f.ordinal).padStart(2, "0") : f.ordinal}
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>

          {active != null && (
            <div className="flex items-center gap-3 border-t border-[var(--sc-border-2)] px-3 py-1.5 font-mono text-[11px]">
              <span className="rounded-[var(--radius-xs)] bg-[var(--sc-surface-3)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--sc-text-2)]">
                {totalSteps >= 10 ? String(active.ordinal).padStart(2, "0") : active.ordinal}
              </span>
              {activeCmd && <span className="text-[var(--sc-text)]">{activeCmd.verb}</span>}
              <span className="min-w-0 flex-1 truncate text-[var(--sc-text-3)]">
                {activeCmd ? summarizeTarget(activeCmd) : ""}
              </span>
              <span className="text-[10px] tabular-nums text-[var(--sc-text-3)]">
                {active.duration_ms}ms
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="h-1 w-1 rounded-full"
                  style={{
                    background:
                      active.match_kind === "primary"
                        ? "var(--sc-success)"
                        : active.match_kind === "fuzzy"
                          ? "var(--sc-warn)"
                          : "var(--sc-text-4)",
                  }}
                />
                <span className="text-[10px] text-[var(--sc-text-3)]">
                  {active.match_kind === "primary"
                    ? "matched"
                    : active.match_kind === "fuzzy"
                      ? "fuzzy"
                      : "none"}
                </span>
              </span>
              {active.match_kind === "fuzzy" && (
                <button
                  type="button"
                  aria-label={`Promote matched selector for step ${active.ordinal} to fallback`}
                  title="Promote to fallback"
                  onClick={() => {
                    void (async () => {
                      if (!sessionId) return;
                      try {
                        await simulatorPromoteFallback(sessionId, active.ordinal);
                        toast.success(`Fallback added for step ${active.ordinal}`);
                      } catch (err) {
                        toast.error(`Could not write fallback (${String(err)})`);
                      }
                    })();
                  }}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-xs)] border border-[var(--sc-border)] bg-[var(--sc-surface-3)] text-[var(--sc-text-2)] hover:bg-[var(--sc-surface-4)] active:translate-y-[1px]"
                >
                  <ArrowUpRight size={11} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {isRunning && inFlightOrdinal != null && (
            <div
              className="flex items-center gap-2 border-t border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-3 py-1.5 text-[11px] text-[var(--sc-text-2)]"
              role="status"
              aria-live="polite"
            >
              <Loader2 size={11} aria-hidden="true" className="animate-spin" />
              <span className="truncate font-mono">
                Running step {inFlightOrdinal}
                {inFlightSummary}
                {inFlightElapsedMs >= 3000 ? ` · ${Math.round(inFlightElapsedMs / 1000)}s` : ""}
              </span>
              {inFlightElapsedMs >= 8000 && (
                <span className="ml-auto text-[10px] text-[var(--sc-warn)]">
                  Taking longer than expected — selector may not match
                </span>
              )}
            </div>
          )}

          {isFailed &&
            (() => {
              const failedCmd = currentOrd != null ? commandByOrdinal.get(currentOrd) : null;
              const failedSummary = failedCmd
                ? `${failedCmd.verb} ${summarizeTarget(failedCmd)}`
                : null;
              // Restrict re-pick to verbs whose lines `rewriteEmitted` knows
              // how to preserve (verb + optional `timeout` modifier). Adding
              // type/select/upload here would lose their `with "..."` /
              // value / path tail when the line is replaced.
              const canRePick =
                failedCmd != null &&
                streamId != null &&
                (TARGET_VERBS as readonly string[]).includes(failedCmd.verb);
              return (
                <div
                  className="flex items-start gap-2 border-t-2 border-[var(--sc-record)] bg-[var(--sc-record)]/20 px-3 py-2 text-[12px] font-medium text-[var(--sc-record)]"
                  role="alert"
                >
                  <AlertTriangle size={14} aria-hidden="true" className="shrink-0 mt-[1px]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-semibold">
                      Step {currentOrd ?? "?"} failed
                      {failedSummary ? ` · ${failedSummary}` : ""}
                    </span>
                    <span className="truncate font-mono text-[11px] opacity-90">
                      {error ?? "selector not found"}
                    </span>
                  </div>
                  {canRePick && failedCmd && (
                    <button
                      type="button"
                      onClick={() => {
                        const ok = editorController.jumpToLine(failedCmd.span.line);
                        if (!ok) {
                          toast.error("Editor not ready");
                          return;
                        }
                        triggerPickFromEditor();
                      }}
                      className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--sc-record)]/50 bg-[var(--sc-record)]/15 px-2 py-0.5 text-[11px] font-semibold hover:bg-[var(--sc-record)]/30 active:translate-y-[1px]"
                      aria-label="Re-pick selector for failed step"
                      title="Jump to line and start picker"
                    >
                      <Crosshair size={11} aria-hidden="true" />
                      Pick selector
                    </button>
                  )}
                  {active?.matched_selector && (
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(active.matched_selector ?? "");
                        toast.success("Selector copied");
                      }}
                      className="shrink-0 inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1 py-0.5 hover:bg-[var(--sc-record)]/30 active:translate-y-[1px]"
                      aria-label="Copy matched selector"
                    >
                      <Copy size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })()}
        </>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-6 text-center">
      <p className="text-[10px] text-[var(--sc-text-3)]">Run to replay this story.</p>
    </div>
  );
}

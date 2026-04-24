import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Camera,
  CheckCheck,
  Clock,
  Copy,
  Hourglass,
  Keyboard,
  ListChecks,
  MousePointerClick,
  Move,
  MoveVertical,
  Play,
  Pointer,
  Upload,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, type KeyboardEvent } from "react";
import { toast } from "sonner";

import type { Command, SelectorOrText } from "@/ipc/parse";
import {
  simulatorCancel,
  simulatorPromoteFallback,
  simulatorStart,
} from "@/ipc/simulator";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

interface SimulatorTimelineProps {
  projectFolder: string;
  storyPath: string;
  storySource: string;
  streamId: string | null;
  appUrlValid: boolean;
}

function verbIcon(verb: string): LucideIcon {
  switch (verb) {
    case "navigate":
      return ArrowRight;
    case "wait-for":
      return Hourglass;
    case "wait":
      return Clock;
    case "click":
      return MousePointerClick;
    case "type":
      return Keyboard;
    case "hover":
      return Pointer;
    case "scroll":
      return MoveVertical;
    case "select":
      return ListChecks;
    case "assert":
      return CheckCheck;
    case "screenshot":
      return Camera;
    case "drag":
      return Move;
    case "upload":
      return Upload;
    default:
      return Zap;
  }
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
    default:
      return "";
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
  const setCurrent = useSimulatorStore((s) => s.setCurrentFrameOrdinal);
  const ast = useEditorStore((s) => s.lastParse?.ast ?? null);

  const isRunning = runState === "running";
  const isFailed = runState === "failed";
  const active = currentOrd != null ? frames[currentOrd - 1] ?? null : null;
  const totalDuration = useMemo(
    () => frames.reduce((acc, f) => acc + f.duration_ms, 0),
    [frames],
  );

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
    if (!canRun) {
      console.log("[sim] Run aborted — canRun=false");
      return;
    }
    try {
      const sid = await simulatorStart(
        {
          projectFolder,
          storySource,
          storyPath,
          streamId: streamId!,
          stopAfterOrdinal: undefined,
        },
        (e) => useSimulatorStore.getState().handleEvent(e),
      );
      console.log("[sim] simulatorStart resolved", sid);
    } catch (err) {
      console.error("[sim] simulatorStart threw", err);
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

  const activeCmd = currentOrd != null ? commandByOrdinal.get(currentOrd) ?? null : null;

  return (
    <section
      role="region"
      aria-labelledby="simulator-panel-title"
      className="flex flex-col overflow-hidden border-t border-[var(--sc-border)] bg-[var(--sc-surface)]"
      style={{ minHeight: 128, maxHeight: "30vh" }}
    >
      <header className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
        <h3 id="simulator-panel-title" className="sr-only">Simulator</h3>
        <span className="font-mono text-[10px] tabular-nums text-[var(--sc-text-3)]">
          {frames.length > 0
            ? `Step ${currentOrd ?? "—"} / ${totalSteps} · ${totalDuration} ms`
            : isRunning
              ? "Preparing…"
              : "Idle"}
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
        <div className="border-b border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-3 py-2 text-[11px] text-[var(--sc-text-3)]">
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
            <div className="flex items-center gap-3 border-t border-[var(--sc-border)] px-3 py-1.5 font-mono text-[11px]">
              <span className="rounded-[var(--radius-xs)] bg-[var(--sc-surface-3)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--sc-text-2)]">
                {totalSteps >= 10 ? String(active.ordinal).padStart(2, "0") : active.ordinal}
              </span>
              {activeCmd && (
                <span className="text-[var(--sc-text)]">{activeCmd.verb}</span>
              )}
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

          {isFailed && (
            <div className="flex items-center gap-2 border-t border-[var(--sc-record)]/30 bg-[var(--sc-record)]/8 px-3 py-1.5 text-[11px] text-[var(--sc-record)]">
              <AlertTriangle size={11} aria-hidden="true" />
              <span className="truncate font-mono">
                Step {currentOrd ?? "?"}: {error ?? "selector not found"}
              </span>
              {active?.matched_selector && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(active.matched_selector ?? "");
                    toast.success("Selector copied");
                  }}
                  className="ml-auto inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1 py-0.5 hover:bg-[var(--sc-record)]/18 active:translate-y-[1px]"
                  aria-label="Copy matched selector"
                >
                  <Copy size={10} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
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

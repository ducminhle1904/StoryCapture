/**
 * Dry-Run summary panel (Plan 03-18).
 *
 * Bottom resizable drawer below editor.
 * - Header: title + "Chay thu" primary button (accent) OR "Huy" warning while running.
 * - Body: ScrollArea with DryRunStepRow list.
 * - Footer: summary stats.
 * - Keyboard: Cmd+Shift+D starts; Esc (hold 400ms) cancels.
 * - Accessibility: role="region", aria-labelledby title.
 */

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Play, X } from "lucide-react";
import { useDryRunStore } from "./dryRunStore";
import { DryRunStepRow } from "./DryRunStepRow";
import type { StoryStep } from "./useDryRun";

export interface DryRunPanelProps {
  steps: StoryStep[];
  onStart: (steps: StoryStep[]) => void;
  onCancel: () => void;
  onStepClick?: (stepId: string) => void;
  className?: string;
}

export function DryRunPanel({
  steps,
  onStart,
  onCancel,
  onStepClick,
  className,
}: DryRunPanelProps) {
  const {
    statusByStep,
    timingByStep,
    fallbackChainByStep,
    summary,
    panelOpen,
    taskId,
    togglePanel,
  } = useDryRunStore();

  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [cancelHoldProgress, setCancelHoldProgress] = useState(false);
  const cancelTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isRunning = Object.values(statusByStep).some(
    (s) => s === "running" || s === "queued",
  );

  // Keyboard shortcut: Cmd+Shift+D
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === "d") {
        e.preventDefault();
        onStart(steps);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onStart, steps]);

  // Esc hold 400ms to cancel
  useEffect(() => {
    if (!isRunning) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cancelTimerRef.current) {
        setCancelHoldProgress(true);
        cancelTimerRef.current = window.setTimeout(() => {
          onCancel();
          setCancelHoldProgress(false);
          cancelTimerRef.current = null;
        }, 400);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cancelTimerRef.current) {
        window.clearTimeout(cancelTimerRef.current);
        cancelTimerRef.current = null;
        setCancelHoldProgress(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      if (cancelTimerRef.current) {
        window.clearTimeout(cancelTimerRef.current);
        cancelTimerRef.current = null;
      }
    };
  }, [isRunning, onCancel]);

  // Arrow key navigation within panel
  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, steps.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && focusedIndex >= 0 && focusedIndex < steps.length) {
        e.preventDefault();
        onStepClick?.(steps[focusedIndex].id);
      }
    },
    [focusedIndex, steps, onStepClick],
  );

  if (!panelOpen) {
    return null;
  }

  const hasResults = summary !== null || Object.keys(statusByStep).length > 0;

  return (
    <div
      ref={panelRef}
      data-testid="dryrun-panel"
      role="region"
      aria-labelledby="dryrun-panel-title"
      className={cn(
        "border-t border-[var(--color-border,#242733)] bg-[var(--color-card,#13151C)]",
        "min-h-[120px] max-h-[40vh] overflow-hidden flex flex-col",
        className,
      )}
      onKeyDown={handlePanelKeyDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border,#242733)]">
        <h3
          id="dryrun-panel-title"
          className="text-sm font-semibold text-[var(--color-foreground,#E6E8EE)]"
        >
          Dry-Run
        </h3>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={onCancel}
              data-testid="dryrun-cancel-btn"
            >
              <X className="w-3.5 h-3.5 mr-1" />
              {cancelHoldProgress ? "Gi\u1eef \u0111\u1ec3 hu\u1ef7\u2026" : "Hu\u1ef7"}
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-[var(--color-accent,#7C3AED)] hover:bg-[var(--color-accent,#7C3AED)]/90 text-white"
              onClick={() => onStart(steps)}
              data-testid="dryrun-start-btn"
            >
              <Play className="w-3.5 h-3.5 mr-1" />
              {"Ch\u1ea1y th\u1eed"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={togglePanel}
            aria-label="Thu g\u1ecdn panel"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-2 py-1" role="grid">
        {!hasResults ? (
          <div className="flex flex-col items-center justify-center h-full py-8 text-center">
            <p className="text-sm text-[var(--color-muted-foreground,#8A90A2)]">
              {"Ch\u01b0a c\u00f3 l\u1ea7n ch\u1ea1y th\u1eed n\u00e0o"}
            </p>
            <p className="text-xs text-[var(--color-muted-foreground,#8A90A2)] mt-1">
              {"Nh\u1ea5n \"Ch\u1ea1y th\u1eed\" \u0111\u1ec3 chromiumoxide th\u1ef1c thi story m\u00e0 kh\u00f4ng quay m\u00e0n h\u00ecnh \u2014 h\u1eefu \u00edch \u0111\u1ec3 debug selector nhanh."}
            </p>
          </div>
        ) : (
          steps.map((step, idx) => (
            <DryRunStepRow
              key={step.id}
              stepNumber={idx + 1}
              stepId={step.id}
              label={step.label ?? `${step.verb} ${Object.values(step.args).join(" ")}`}
              status={statusByStep[step.id] ?? "queued"}
              durationMs={timingByStep[step.id]}
              fallbackChain={fallbackChainByStep[step.id]}
              onStepClick={onStepClick}
              focused={focusedIndex === idx}
            />
          ))
        )}
      </div>

      {/* Summary footer */}
      {summary && (
        <div
          data-testid="dryrun-summary"
          className="flex items-center gap-4 px-4 py-2 border-t border-[var(--color-border,#242733)] text-xs"
        >
          <span className="text-[var(--color-success,#30A46C)] font-semibold">
            {summary.passed} pass
          </span>
          <span className="text-[var(--color-destructive,#E5484D)] font-semibold">
            {summary.failed} fail
          </span>
          <span className="text-[var(--color-muted-foreground,#8A90A2)] tabular-nums font-[family-name:var(--font-mono,'JetBrains_Mono')]">
            {summary.totalMs}ms total
          </span>
        </div>
      )}
    </div>
  );
}

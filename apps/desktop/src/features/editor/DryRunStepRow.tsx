import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { DryRunStepStatus, SelectorAttempt } from "./dryRunStore";

export interface DryRunStepRowProps {
  stepNumber: number;
  stepId: string;
  label: string;
  status: DryRunStepStatus;
  durationMs?: number;
  fallbackChain?: SelectorAttempt[];
  onStepClick?: (stepId: string) => void;
  focused?: boolean;
}

const statusConfig: Record<
  DryRunStepStatus,
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "bg-[var(--color-info,#4493F8)] text-[var(--color-fg-primary)]" },
  running: { label: "Running", className: "bg-[var(--color-info,#4493F8)] text-[var(--color-fg-primary)]" },
  pass: { label: "Pass", className: "bg-[var(--color-success,#30A46C)] text-[var(--color-fg-primary)]" },
  fail: { label: "Fail", className: "bg-[var(--color-destructive,#E5484D)] text-[var(--color-fg-primary)]" },
  skipped: { label: "Skipped", className: "bg-[var(--color-muted-foreground,#8A90A2)] text-[var(--color-fg-primary)]" },
};

export function DryRunStepRow({
  stepNumber,
  stepId,
  label,
  status,
  durationMs,
  fallbackChain,
  onStepClick,
  focused,
}: DryRunStepRowProps) {
  const config = statusConfig[status];

  return (
    <motion.div
      role="row"
      tabIndex={0}
      data-testid={`dryrun-step-${stepId}`}
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md",
        "hover:bg-[var(--color-card,#13151C)] transition-colors",
        focused && "ring-2 ring-[var(--color-accent,#7C3AED)]",
      )}
      onClick={() => onStepClick?.(stepId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onStepClick?.(stepId);
        }
      }}
      initial={false}
      animate={{ backgroundColor: status === "running" ? "rgba(68,147,248,0.12)" : "transparent" }}
      transition={{ duration: 0.16, ease: "easeInOut" }}
    >
      <span className="text-xs font-semibold text-[var(--color-muted-foreground,#8A90A2)] w-6 text-right tabular-nums font-[family-name:var(--font-mono,'JetBrains_Mono')]">
        {stepNumber}
      </span>

      <span
        data-testid={`status-badge-${stepId}`}
        className={cn(
          "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold leading-4",
          config.className,
        )}
      >
        {config.label}
      </span>

      <span className="flex-1 text-sm text-[var(--color-foreground,#E6E8EE)] truncate">
        {label}
      </span>

      {durationMs != null && (
        <span className="text-xs text-[var(--color-muted-foreground,#8A90A2)] tabular-nums font-[family-name:var(--font-mono,'JetBrains_Mono')]">
          {durationMs}ms
        </span>
      )}

      {fallbackChain && fallbackChain.length > 0 && (
        <div className="flex gap-1">
          {fallbackChain.map((attempt, idx) => (
            <span
              key={`${attempt.strategy}-${idx}`}
              title={`${attempt.strategy}: ${attempt.durationMs}ms`}
              className={cn(
                "inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold leading-3",
                attempt.succeeded
                  ? "bg-[var(--color-success,#30A46C)]/20 text-[var(--color-success,#30A46C)]"
                  : "bg-[var(--color-muted-foreground,#8A90A2)]/20 text-[var(--color-muted-foreground,#8A90A2)]",
              )}
            >
              {attempt.strategy}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

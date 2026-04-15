import { useRecorderStore } from "@/state/recorder";

/** Progress dots colored by step status (UI-04). */
export function StepProgress() {
  const steps = useRecorderStore((s) => s.steps);
  const currentStep = useRecorderStore((s) => s.currentStep);

  if (steps.length === 0) return null;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={currentStep}
      aria-label={`Step ${currentStep + 1} of ${steps.length}`}
      className="flex items-center gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2"
    >
      <span className="text-xs text-[var(--color-fg-muted)] min-w-[70px] text-right">
        Step {currentStep + 1}/{steps.length}
      </span>
      <div className="flex gap-1 flex-1 overflow-hidden">
        {steps.map((step, i) => {
          let cls = "bg-[var(--color-border-default)]";
          if (step.status === "running")
            cls = "bg-[var(--color-accent-primary)]/60 animate-pulse";
          else if (step.status === "succeeded") cls = "bg-[var(--color-success)]";
          else if (step.status === "failed") cls = "bg-[var(--color-danger)]";
          return (
            <div
              key={i}
              className={`h-2 flex-1 min-w-[4px] rounded-sm transition-colors ${cls}`}
              title={`${step.verb} — ${step.status}`}
              aria-hidden="true"
            />
          );
        })}
      </div>
    </div>
  );
}

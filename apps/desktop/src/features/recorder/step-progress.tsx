import { useRecorderStore } from "@/state/recorder";

/** Progress dots colored by step status (UI-04). */
export function StepProgress() {
  const steps = useRecorderStore((s) => s.steps);
  const currentStep = useRecorderStore((s) => s.currentStep);

  if (steps.length === 0) return null;

  const activeStep = steps[Math.min(currentStep, steps.length - 1)];

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={currentStep}
      aria-label={`Step ${currentStep + 1} of ${steps.length}`}
      className="rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-4 py-4"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center">
        <div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-secondary)]">
              Step {currentStep + 1}/{steps.length}
            </span>
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
              {activeStep?.verb ?? "waiting"}
            </span>
          </div>
          <div className="mt-3 flex gap-1 overflow-hidden rounded-full bg-[var(--color-background-card)] p-[3px]">
            {steps.map((step) => {
              let cls = "bg-[var(--color-background-popover)]";
              if (step.status === "running") cls = "bg-[var(--color-accent)]/70 animate-pulse";
              else if (step.status === "succeeded") cls = "bg-[var(--color-success)]";
              else if (step.status === "failed") cls = "bg-[var(--color-error)]";
              return (
                <div
                  key={step.index}
                  className={`h-2 flex-1 min-w-[4px] rounded-full transition-colors ${cls}`}
                  title={`${step.verb} — ${step.status}`}
                  aria-hidden="true"
                />
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
          {steps.slice(Math.max(0, currentStep - 1), currentStep + 2).map((step) => (
            <span
              key={step.index}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-secondary)]"
            >
              {step.verb}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

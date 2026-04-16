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
      className="rounded-[22px] border border-white/8 bg-[rgba(255,255,255,0.03)] px-4 py-4"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px] lg:items-center">
        <div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-fg-muted)]">
              Step {currentStep + 1}/{steps.length}
            </span>
            <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-secondary)]">
              {activeStep?.verb ?? "waiting"}
            </span>
          </div>
          <div className="mt-3 flex gap-1 overflow-hidden rounded-full bg-white/4 p-[3px]">
            {steps.map((step, i) => {
              let cls = "bg-white/8";
              if (step.status === "running")
                cls = "bg-[var(--color-accent-primary)]/70 animate-pulse";
              else if (step.status === "succeeded")
                cls = "bg-[var(--color-success)]";
              else if (step.status === "failed")
                cls = "bg-[var(--color-danger)]";
              return (
                <div
                  key={i}
                  className={`h-2 flex-1 min-w-[4px] rounded-full transition-colors ${cls}`}
                  title={`${step.verb} — ${step.status}`}
                  aria-hidden="true"
                />
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
          {steps.slice(Math.max(0, currentStep - 1), currentStep + 2).map((step, index) => (
            <span
              key={`${step.verb}-${index}`}
              className="rounded-full border border-white/8 bg-black/12 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-secondary)]"
            >
              {step.verb}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

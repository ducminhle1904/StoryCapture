import { Check, Circle, Clapperboard, DraftingCompass, Sparkles } from "lucide-react";

import type { WorkflowState, WorkflowStep, WorkflowStepStatus } from "@/ipc/projects";
import { getWorkflowEntry } from "./workflow-catalog";

interface WorkflowRoadmapPanelProps {
  workflow: WorkflowState;
  onChange: (workflow: WorkflowState) => void;
  disabled?: boolean;
}

const statusOrder: WorkflowStepStatus[] = ["todo", "drafted", "recorded", "polished"];

const statusLabels: Record<WorkflowStepStatus, string> = {
  todo: "Todo",
  drafted: "Drafted",
  recorded: "Recorded",
  polished: "Polished",
};

const statusIcons = {
  todo: Circle,
  drafted: DraftingCompass,
  recorded: Clapperboard,
  polished: Sparkles,
} as const;

export function WorkflowRoadmapPanel({
  workflow,
  onChange,
  disabled = false,
}: WorkflowRoadmapPanelProps) {
  const entry = getWorkflowEntry(workflow.type);
  if (!entry) return null;

  const counts = statusOrder.map((status) => ({
    status,
    count: workflow.steps.filter((step) => step.status === status).length,
  }));

  const updateStep = (stepId: string, status: WorkflowStepStatus) => {
    const current = workflow.steps.find((step) => step.id === stepId);
    if (!current || current.status === status) return;

    onChange({
      ...workflow,
      updatedAt: Date.now(),
      steps: workflow.steps.map((step) => (step.id === stepId ? { ...step, status } : step)),
    });
  };

  return (
    <section className="border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles size={14} aria-hidden="true" className="text-[var(--sc-accent-400)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold uppercase text-[var(--sc-text-3)]">
            {entry.title} roadmap
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {counts.map(({ status, count }) => (
              <span
                key={status}
                className="rounded-full border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--sc-text-4)]"
              >
                {statusLabels[status]} {count}
              </span>
            ))}
          </div>
        </div>
      </div>

      <ol className="grid gap-2 px-3 pb-3 md:grid-cols-2">
        {workflow.steps.map((step, index) => (
          <WorkflowStepRow
            key={step.id}
            index={index}
            step={step}
            disabled={disabled}
            onStatusChange={(status) => updateStep(step.id, status)}
          />
        ))}
      </ol>
    </section>
  );
}

function WorkflowStepRow({
  index,
  step,
  disabled,
  onStatusChange,
}: {
  index: number;
  step: WorkflowStep;
  disabled: boolean;
  onStatusChange: (status: WorkflowStepStatus) => void;
}) {
  const StatusIcon = statusIcons[step.status];
  const currentIndex = statusOrder.indexOf(step.status);
  const nextStatus = statusOrder[Math.min(currentIndex + 1, statusOrder.length - 1)] ?? "polished";

  return (
    <li className="min-w-0 rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-3">
      <div className="flex items-start gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--sc-surface-3)] font-mono text-[10px] text-[var(--sc-text-3)]">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-[var(--sc-text)]">
              {step.title}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--sc-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--sc-text-4)]">
              <StatusIcon size={10} aria-hidden="true" />
              {statusLabels[step.status]}
            </span>
          </div>
          {step.sceneName ? (
            <div className="mt-1 truncate font-mono text-[10px] text-[var(--sc-text-4)]">
              Scene: {step.sceneName}
            </div>
          ) : null}
          {step.notes ? (
            <div className="mt-1 text-xs leading-5 text-[var(--sc-text-3)]">{step.notes}</div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {statusOrder.map((status) => (
              <button
                key={status}
                type="button"
                disabled={disabled || step.status === status}
                onClick={() => onStatusChange(status)}
                className={[
                  "inline-flex h-6 items-center gap-1 rounded-[var(--sc-r-sm)] border px-2 text-[10px] font-medium transition active:scale-[0.98] disabled:opacity-50",
                  step.status === status
                    ? "border-[var(--sc-accent-400)] bg-[var(--sc-accent-400)]/12 text-[var(--sc-text)]"
                    : "border-[var(--sc-border)] bg-[var(--sc-surface-2)] text-[var(--sc-text-3)] hover:text-[var(--sc-text)]",
                ].join(" ")}
              >
                {step.status === status ? <Check size={10} aria-hidden="true" /> : null}
                {statusLabels[status]}
              </button>
            ))}
            {step.status !== "polished" ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onStatusChange(nextStatus)}
                className="inline-flex h-6 items-center rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 text-[10px] font-medium text-[var(--sc-text-3)] transition hover:text-[var(--sc-text)] active:scale-[0.98] disabled:opacity-50"
              >
                Advance
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

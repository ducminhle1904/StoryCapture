import { ScButton } from "@storycapture/ui";
import { ArrowLeft, Check } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  deriveProjectStagePresentation,
  PROJECT_STAGES,
  type ProjectStage,
  type ProjectWorkflowSnapshot,
  projectStagePath,
} from "./project-stage";

interface ProjectStageHeaderProps {
  projectId: string;
  projectName: string;
  workflowLabel?: string;
  currentStage: ProjectStage;
  snapshot: ProjectWorkflowSnapshot;
  navigationLocked?: boolean;
  primaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
    ariaLabel?: string;
    tone?: "primary" | "danger" | "success";
  };
  onStageChange?: (stage: ProjectStage) => boolean | undefined;
  onExport?: () => void;
}

export function ProjectStageHeader({
  projectId,
  projectName,
  workflowLabel,
  currentStage,
  snapshot,
  navigationLocked = false,
  primaryAction,
  onStageChange,
  onExport,
}: ProjectStageHeaderProps) {
  const navigate = useNavigate();

  const selectStage = (stage: ProjectStage) => {
    const presentation = deriveProjectStagePresentation(stage, currentStage, snapshot);
    if (navigationLocked || presentation.state === "blocked") return;
    if (onStageChange?.(stage) === true) return;
    if (stage === "export" && onExport) {
      onExport();
      return;
    }
    navigate(projectStagePath(projectId, stage), {
      state: stage === "export" ? { openExport: true } : undefined,
    });
  };

  return (
    <header className="sc-window-chrome grid h-[58px] shrink-0 grid-cols-[minmax(180px,1fr)_auto_minmax(180px,1fr)] items-center border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome)] px-3">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] text-[var(--sc-text-3)] transition-colors hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sc-focus)]"
          aria-label="Back to projects"
          disabled={navigationLocked}
        >
          <ArrowLeft size={13} aria-hidden="true" />
        </button>
        <span className="grid min-w-0 gap-px">
          <strong className="truncate text-xs font-semibold text-[var(--sc-text)]">
            {projectName}
          </strong>
          {workflowLabel ? (
            <small className="truncate text-[10.5px] text-[var(--sc-text-3)]">
              {workflowLabel}
            </small>
          ) : null}
        </span>
      </div>

      <nav
        aria-label="Project stages"
        className="flex items-center gap-0.5 rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-0.5"
      >
        {PROJECT_STAGES.map((stage, index) => {
          const presentation = deriveProjectStagePresentation(stage.id, currentStage, snapshot);
          const blocked = navigationLocked || presentation.state === "blocked";
          const active = stage.id === currentStage;
          const complete = presentation.state === "complete";
          const attention = presentation.state === "needs_attention";
          return (
            <button
              key={stage.id}
              type="button"
              disabled={blocked}
              aria-current={active ? "step" : undefined}
              aria-label={`${stage.label}: ${presentation.state.replace("_", " ")}`}
              title={presentation.reason}
              onClick={() => selectStage(stage.id)}
              className={`flex h-7 items-center gap-1.5 rounded-[var(--sc-r-sm)] px-2.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--sc-focus)] disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-[color-mix(in_oklch,var(--sc-accent-400)_11%,var(--sc-surface-2))] text-[var(--sc-text)]"
                  : "text-[var(--sc-text-3)] hover:bg-[var(--sc-surface-2)] hover:text-[var(--sc-text)]"
              }`}
            >
              <span
                className={`grid h-[15px] w-[15px] place-items-center rounded-full border font-mono text-[8px] ${
                  active
                    ? "border-[var(--sc-accent-400)] bg-[var(--sc-accent-500)] text-[var(--sc-accent-fg)]"
                    : complete
                      ? "border-[color-mix(in_oklch,var(--sc-success)_45%,var(--sc-border))] text-[var(--sc-success)]"
                      : attention
                        ? "border-[color-mix(in_oklch,var(--sc-warn)_55%,var(--sc-border))] text-[var(--sc-warn)]"
                        : "border-[var(--sc-border-2)]"
                }`}
                aria-hidden="true"
              >
                {complete ? <Check size={9} /> : attention ? "!" : index + 1}
              </span>
              {stage.label}
            </button>
          );
        })}
      </nav>

      <div className="flex justify-end">
        {primaryAction ? (
          <ScButton
            size="sm"
            variant={primaryAction.tone ?? "primary"}
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            title={primaryAction.title}
            aria-label={primaryAction.ariaLabel}
          >
            {primaryAction.label}
          </ScButton>
        ) : null}
      </div>
    </header>
  );
}

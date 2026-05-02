export const workflowTypeLabels: Record<string, string> = {
  PRODUCT_DEMO: "Product Demo",
  TUTORIAL: "Tutorial / How-to",
  FEATURE_LAUNCH: "Feature Launch",
  SALES_MARKETING: "Sales / Marketing Demo",
  SUPPORT: "Support / Troubleshooting",
  INTERNAL_TRAINING: "Internal Training",
  BUG_REPRODUCTION: "Bug Reproduction",
  DOCUMENTATION: "Documentation Video",
  FREESTYLE: "Freestyle",
};

export interface WorkflowStepView {
  id: string;
  title: string;
  status: string;
  sceneName?: string | null;
  notes?: string | null;
}

export interface WorkflowStateView {
  version: number;
  type: string;
  steps: WorkflowStepView[];
  createdAt?: number | string;
  updatedAt?: number | string;
}

export function formatWorkflowType(value: string | null | undefined): string | null {
  if (!value) return null;
  return workflowTypeLabels[value] ?? value;
}

export function summarizeWorkflowState(state: unknown): Record<string, number> {
  if (!isWorkflowStateView(state)) return {};
  return state.steps.reduce<Record<string, number>>((acc, step) => {
    acc[step.status] = (acc[step.status] ?? 0) + 1;
    return acc;
  }, {});
}

export function workflowSteps(state: unknown): WorkflowStepView[] {
  if (!isWorkflowStateView(state)) return [];
  return state.steps;
}

export function isWorkflowStateView(value: unknown): value is WorkflowStateView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; type?: unknown; steps?: unknown };
  return (
    typeof candidate.version === "number" &&
    typeof candidate.type === "string" &&
    Array.isArray(candidate.steps)
  );
}

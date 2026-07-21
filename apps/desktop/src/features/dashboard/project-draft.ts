import type { WorkflowCatalogEntry, WorkflowInputs } from "@/features/workflows/workflow-catalog";

export interface OnboardingProjectDraft {
  workflowType: WorkflowCatalogEntry["id"];
  workflowInputs: Partial<WorkflowInputs>;
}

export function buildOnboardingProjectDraft(
  workflowType: OnboardingProjectDraft["workflowType"],
  targetUrl: string,
  useSample: boolean,
): OnboardingProjectDraft {
  return {
    workflowType,
    workflowInputs: {
      target_url: useSample ? "https://example.com" : targetUrl.trim(),
    },
  };
}

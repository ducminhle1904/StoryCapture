import { useProjectRecordings, useProjectWorkflow } from "@/ipc/projects";

export function useProjectDashboardSummary(projectId: string) {
  const recordings = useProjectRecordings(projectId);
  const workflow = useProjectWorkflow(projectId);

  return {
    sessionCount: recordings.data?.length,
    workflowType: workflow.data?.type,
    isLoading: recordings.isLoading || workflow.isLoading,
  };
}

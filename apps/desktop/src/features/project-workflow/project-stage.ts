import type { RunState } from "@/state/simulator-store";

export type ProjectStage = "author" | "preview" | "record" | "edit" | "export";
export type ProjectStageState =
  | "current"
  | "available"
  | "complete"
  | "blocked"
  | "needs_attention";

export interface ProjectWorkflowSnapshot {
  storyValid: boolean;
  previewState: RunState;
  hasValidRecording: boolean;
  editState: "unavailable" | "review" | "ready";
  exportReady: boolean;
  exportBlockedReason?: string;
}

export interface ProjectStagePresentation {
  state: ProjectStageState;
  reason?: string;
}

export const PROJECT_STAGES: ReadonlyArray<{ id: ProjectStage; label: string }> = [
  { id: "author", label: "Author" },
  { id: "preview", label: "Preview" },
  { id: "record", label: "Record" },
  { id: "edit", label: "Edit" },
  { id: "export", label: "Export" },
];

export function deriveProjectStagePresentation(
  stage: ProjectStage,
  currentStage: ProjectStage,
  snapshot: ProjectWorkflowSnapshot,
): ProjectStagePresentation {
  if (stage === currentStage) {
    if (stage === "author" && !snapshot.storyValid) return { state: "needs_attention" };
    if (stage === "preview" && snapshot.previewState === "failed") {
      return { state: "needs_attention", reason: "Preview failed. Retry the failed step." };
    }
    if (stage === "edit" && snapshot.editState === "review") return { state: "needs_attention" };
    return { state: "current" };
  }

  if (stage === "author") {
    return { state: snapshot.storyValid ? "complete" : "needs_attention" };
  }
  if (stage === "preview") {
    if (snapshot.previewState === "complete") return { state: "complete" };
    if (snapshot.previewState === "failed") {
      return { state: "needs_attention", reason: "Preview failed. Retry before recording." };
    }
    return { state: "available" };
  }
  if (stage === "record") {
    if (!snapshot.storyValid) {
      return { state: "blocked", reason: "Fix story validation errors before recording." };
    }
    return { state: snapshot.hasValidRecording ? "complete" : "available" };
  }
  if (stage === "edit") {
    if (!snapshot.hasValidRecording) {
      return { state: "blocked", reason: "Record a valid take before editing." };
    }
    return { state: snapshot.editState === "ready" ? "complete" : "needs_attention" };
  }
  if (!snapshot.hasValidRecording) {
    return { state: "blocked", reason: "Record a valid take before exporting." };
  }
  if (!snapshot.exportReady) {
    return {
      state: "blocked",
      reason: snapshot.exportBlockedReason ?? "Resolve export preflight issues first.",
    };
  }
  return { state: "available" };
}

export function projectStagePath(projectId: string, stage: ProjectStage): string {
  if (stage === "record") return `/recorder/${projectId}`;
  if (stage === "edit" || stage === "export") return `/post-production/${projectId}`;
  return `/editor/${projectId}`;
}

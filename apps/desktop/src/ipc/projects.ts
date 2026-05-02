/**
 * Dashboard / project IPC hooks.
 *
 * Typed wrappers around the `list_projects` / `create_project` /
 * `open_project` / `remove_project` Tauri commands (Rust:
 * `apps/desktop/src-tauri/src/commands/projects.rs`).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: string;
  name: string;
  folder_path: string;
  created_at: number;
  last_opened_at: number | null;
  thumbnail_path: string | null;
}

export interface ProjectFolderInfo {
  id: string;
  name: string;
  folder_path: string;
  story_path: string;
  exports_dir: string;
  session_count: number;
}

export interface RecordingInfo {
  path: string;
  captured_at: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
}

export type WorkflowType =
  | "product_demo"
  | "tutorial"
  | "feature_launch"
  | "sales_marketing"
  | "support"
  | "internal_training"
  | "bug_reproduction"
  | "documentation"
  | "freestyle";

export type WorkflowStepStatus = "todo" | "drafted" | "recorded" | "polished";

export interface WorkflowStep {
  id: string;
  title: string;
  status: WorkflowStepStatus;
  sceneName?: string;
  requiredInputs: string[];
  notes?: string;
}

export interface WorkflowState {
  version: number;
  type: WorkflowType;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
}

export type WebWorkflowType =
  | "PRODUCT_DEMO"
  | "TUTORIAL"
  | "FEATURE_LAUNCH"
  | "SALES_MARKETING"
  | "SUPPORT"
  | "INTERNAL_TRAINING"
  | "BUG_REPRODUCTION"
  | "DOCUMENTATION"
  | "FREESTYLE";

const WORKFLOW_TYPE_TO_WEB: Record<WorkflowType, WebWorkflowType> = {
  product_demo: "PRODUCT_DEMO",
  tutorial: "TUTORIAL",
  feature_launch: "FEATURE_LAUNCH",
  sales_marketing: "SALES_MARKETING",
  support: "SUPPORT",
  internal_training: "INTERNAL_TRAINING",
  bug_reproduction: "BUG_REPRODUCTION",
  documentation: "DOCUMENTATION",
  freestyle: "FREESTYLE",
};

export interface CreateProjectInput {
  name: string;
  parent: string;
  workflow_type?: WorkflowType;
  starter_story_source?: string;
  workflow_state?: WorkflowState;
}

const KEYS = {
  all: ["projects"] as const,
  detail: (id: string) => ["projects", id] as const,
  folder: (id: string) => ["projects", id, "folder"] as const,
  recordings: (id: string) => ["projects", id, "recordings"] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: fetchProjects,
  });
}

export function fetchProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateProjectInput) => invoke<Project>("create_project", { args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useOpenProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<ProjectFolderInfo>("open_project", { args: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke<void>("remove_project", { args: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

/** One-shot (non-hook) fetch for loaders + imperative flows. */
export async function fetchProjectFolder(id: string): Promise<ProjectFolderInfo> {
  return invoke<ProjectFolderInfo>("open_project", { args: { id } });
}

export function useProjectFolder(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? KEYS.folder(projectId) : ["projects", "__disabled__", "folder"],
    queryFn: () => fetchProjectFolder(projectId as string),
    enabled: !!projectId,
  });
}

export function useProjectRecordings(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? KEYS.recordings(projectId) : ["projects", "__disabled__", "recordings"],
    queryFn: () =>
      invoke<RecordingInfo[]>("list_project_recordings", { args: { id: projectId as string } }),
    enabled: !!projectId,
  });
}

export async function fetchProjectWorkflow(projectId: string): Promise<WorkflowState | null> {
  return invoke<WorkflowState | null>("get_project_workflow", { args: { id: projectId } });
}

export async function fetchProjectWorkflowSyncMetadata(projectId: string): Promise<{
  workflowType: WebWorkflowType | null;
  workflowState: WorkflowState | null;
}> {
  const workflowState = await fetchProjectWorkflow(projectId);
  return {
    workflowType: workflowState ? workflowTypeToWeb(workflowState.type) : null,
    workflowState,
  };
}

export async function updateProjectWorkflow(
  projectId: string,
  workflowState: WorkflowState,
): Promise<WorkflowState> {
  return invoke<WorkflowState>("update_project_workflow", {
    args: { id: projectId, workflow_state: workflowState },
  });
}

export function workflowTypeToWeb(type: WorkflowType): WebWorkflowType {
  return WORKFLOW_TYPE_TO_WEB[type];
}

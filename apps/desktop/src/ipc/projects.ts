/**
 * Dashboard / project IPC hooks (Plan 01-09, UI-01).
 *
 * Typed wrappers around the `list_projects` / `create_project` /
 * `open_project` / `remove_project` Tauri commands (Rust:
 * `apps/desktop/src-tauri/src/commands/projects.rs`). Consumed by
 * `routes/dashboard.tsx` and the editor loader.
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

const KEYS = {
  all: ["projects"] as const,
  detail: (id: string) => ["projects", id] as const,
  folder: (id: string) => ["projects", id, "folder"] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => invoke<Project[]>("list_projects"),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; parent: string }) =>
      invoke<Project>("create_project", { args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useOpenProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      invoke<ProjectFolderInfo>("open_project", { args: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      invoke<void>("remove_project", { args: { id } }),
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

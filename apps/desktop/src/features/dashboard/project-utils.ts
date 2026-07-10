import type { Project } from "@/ipc/projects";

export type SortMode = "recent" | "name";

export function filterAndSort(
  projects: Project[],
  query: string,
  sortMode: SortMode = "recent",
): Project[] {
  const q = query.trim().toLowerCase();
  const out = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : [...projects];
  if (sortMode === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    out.sort((a, b) => (b.last_opened_at ?? b.created_at) - (a.last_opened_at ?? a.created_at));
  }
  return out;
}

export function mostRecentTimestamp(projects: Project[]): number | null {
  let best: number | null = null;
  for (const p of projects) {
    const t = p.last_opened_at ?? p.created_at;
    if (best === null || t > best) best = t;
  }
  return best;
}

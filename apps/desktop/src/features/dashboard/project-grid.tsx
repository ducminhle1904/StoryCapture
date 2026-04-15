import type { Project } from "@/ipc/projects";
import { ProjectCard } from "./project-card";

interface ProjectGridProps {
  projects: Project[];
  onOpen: (id: string) => void;
  emptyHint?: string;
}

export function ProjectGrid({ projects, onOpen, emptyHint }: ProjectGridProps) {
  if (projects.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-12 text-center text-[var(--color-fg-muted)]"
      >
        {emptyHint ?? "No projects yet. Click \u201cNew Project\u201d to get started."}
      </div>
    );
  }

  return (
    <ul
      role="list"
      className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    >
      {projects.map((p) => (
        <li key={p.id}>
          <ProjectCard project={p} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

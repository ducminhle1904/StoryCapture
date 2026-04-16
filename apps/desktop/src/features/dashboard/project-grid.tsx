import { BrandMark, BrandWordmark } from "@/components/brand";
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
        className="brand-panel rounded-[24px] border border-dashed border-white/10 p-12 text-center text-[var(--color-fg-muted)]"
      >
        <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
          <div className="rounded-[22px] bg-white/5 p-3 ring-1 ring-white/8">
            <BrandMark size={56} />
          </div>
          <div className="space-y-2">
            <BrandWordmark className="text-xl text-white" />
            <p className="text-sm text-[var(--color-fg-muted)]">
              {emptyHint ??
                "No projects yet. Start your first story and turn it into a polished demo video."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ul
      role="list"
      className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]"
    >
      {projects.map((p) => (
        <li key={p.id}>
          <ProjectCard project={p} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

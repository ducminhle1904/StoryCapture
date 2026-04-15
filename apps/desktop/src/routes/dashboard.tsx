import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, AlertTriangle } from "lucide-react";
import { motion } from "motion/react";

import { useProjects, type Project } from "@/ipc/projects";
import { useDashboardStore } from "@/state/projects";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { ProjectFilters } from "@/features/dashboard/project-filters";
import { NewProjectDialog } from "@/features/dashboard/new-project-dialog";

function filterAndSort(
  projects: Project[],
  query: string,
  sortMode: "recent" | "name",
): Project[] {
  const q = query.trim().toLowerCase();
  let out = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q))
    : [...projects];
  if (sortMode === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    out.sort(
      (a, b) =>
        (b.last_opened_at ?? b.created_at) - (a.last_opened_at ?? a.created_at),
    );
  }
  return out;
}

export default function DashboardRoute() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects();
  const { searchQuery, sortMode } = useDashboardStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  const visible = useMemo(
    () => filterAndSort(projects ?? [], searchQuery, sortMode),
    [projects, searchQuery, sortMode],
  );

  const openProject = (id: string) => navigate(`/editor/${id}`);

  return (
    <motion.main
      id="main-content"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="mx-auto max-w-6xl p-8"
    >
      <header className="flex items-center justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg-primary)]">
            Projects
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Write a story, record it, ship a demo video.
          </p>
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          aria-label="Create new project"
          className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-primary)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          <Plus size={16} aria-hidden="true" />
          New Project
        </button>
      </header>

      <section aria-label="Filters" className="mt-6">
        <ProjectFilters />
      </section>

      <section aria-label="Projects" className="mt-6">
        {isLoading ? (
          <div
            role="status"
            className="rounded-lg border border-[var(--color-border-subtle)] p-8 text-sm text-[var(--color-fg-muted)]"
          >
            Loading projects…
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            Failed to load projects: {String(error)}
          </div>
        ) : (
          <ProjectGrid projects={visible} onOpen={openProject} />
        )}
      </section>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={openProject}
      />
    </motion.main>
  );
}

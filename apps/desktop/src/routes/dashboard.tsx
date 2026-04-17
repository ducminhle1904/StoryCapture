import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, AlertTriangle } from "lucide-react";
import { useProjects, type Project } from "@/ipc/projects";
import { PageContentTransition } from "@/components/page-content-transition";
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
    <main id="main-content" className="flex h-full flex-col">
      {/* Page header — sticky at top of content pane */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-[var(--color-fg-primary)]">
            Projects
          </h1>
          <span className="text-xs text-[var(--color-fg-muted)]">
            {visible.length} {visible.length === 1 ? "project" : "projects"}
          </span>
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          aria-label="Create new project"
          className="brand-button inline-flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          <Plus size={14} aria-hidden="true" />
          New Project
        </button>
      </header>

      {/* Scrollable body */}
      <PageContentTransition className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">

      <section aria-label="Filters">
        <ProjectFilters />
      </section>

      <section aria-label="Projects" className="mt-6">
        {isLoading ? (
          <div
            role="status"
            className="brand-panel rounded-[var(--radius-2xl)] p-8 text-sm text-[var(--color-fg-muted)]"
          >
            Loading projects…
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-[var(--radius-2xl)] border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            Failed to load projects: {String(error)}
          </div>
        ) : (
          <ProjectGrid projects={visible} onOpen={openProject} />
        )}
      </section>

        </div>
      </PageContentTransition>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={openProject}
      />
    </main>
  );
}

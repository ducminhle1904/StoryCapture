import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, AlertTriangle } from "lucide-react";
import { ScButton, ScCard } from "@storycapture/ui";
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
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--sc-border)] bg-[var(--sc-bg)] px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-[var(--sc-text)]">
            Projects
          </h1>
          <span className="text-xs text-[var(--sc-text-4)]">
            {visible.length} {visible.length === 1 ? "project" : "projects"}
          </span>
        </div>
        <ScButton
          variant="primary"
          icon={<Plus size={14} aria-hidden="true" />}
          onClick={() => setDialogOpen(true)}
          aria-label="Create new project"
        >
          New Project
        </ScButton>
      </header>

      {/* Scrollable body */}
      <PageContentTransition className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">

      <section aria-label="Filters">
        <ProjectFilters />
      </section>

      <section aria-label="Projects" className="mt-6">
        {isLoading ? (
          <ScCard
            role="status"
            className="p-8 text-sm text-[var(--sc-text-4)]"
          >
            Loading projects…
          </ScCard>
        ) : error ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-[var(--sc-r-lg)] border border-[oklch(0.65_0.20_22/0.28)] bg-[oklch(0.65_0.20_22/0.10)] p-4 text-sm text-[oklch(0.80_0.18_22)]"
          >
            <AlertTriangle size={16} aria-hidden="true" />
            Failed to load projects: {String(error)}
          </div>
        ) : (
          <ScCard className="p-3">
            <ProjectGrid projects={visible} onOpen={openProject} />
          </ScCard>
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

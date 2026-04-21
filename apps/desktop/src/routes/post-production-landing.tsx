import { useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { AlertTriangle, Film, Search } from "lucide-react";

import { ScButton, ScCard, ScInput } from "@storycapture/ui";
import { useProjects } from "@/ipc/projects";
import { PageContentTransition } from "@/components/page-content-transition";
import { EmptyState } from "@/components/empty-state/empty-state";
import { useDashboardStore } from "@/state/projects";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { filterAndSort, mostRecentTimestamp } from "@/features/dashboard/project-utils";
import { relativeTime } from "@/lib/utils";

function EmptyPostProduction({ onGoToProjects }: { onGoToProjects: () => void }) {
  return (
    <EmptyState
      icon={Film}
      title="No recordings yet"
      body="Record a story to start post-production."
      actions={
        <ScButton variant="primary" onClick={onGoToProjects}>
          Go to Projects
        </ScButton>
      }
      footer={
        <>
          Try <span className="sc-kbd">⌘K</span> for commands.
        </>
      }
    />
  );
}

export default function PostProductionLandingRoute() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects();
  const { searchQuery, setSearchQuery } = useDashboardStore();
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => filterAndSort(projects ?? [], searchQuery),
    [projects, searchQuery],
  );

  const openProject = (id: string) => navigate(`/post-production/${id}`);
  const goToProjects = () => navigate("/");

  useHotkeys(
    "mod+f",
    (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { enableOnFormTags: true, preventDefault: true },
  );

  const count = projects?.length ?? 0;
  const isEmpty = !isLoading && !error && count === 0;
  const lastOpened = useMemo(() => mostRecentTimestamp(projects ?? []), [projects]);
  const metaLine = isEmpty
    ? "No recordings yet"
    : `${count} ${count === 1 ? "project" : "projects"} · last opened ${relativeTime(lastOpened)}`;

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="sc-toolbar">
        <div>
          <div className="sc-toolbar-title">Post-Production</div>
          <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>
            {metaLine}
          </div>
        </div>
        <span className="sc-spacer" />
        <ScInput
          ref={searchRef}
          icon={<Search size={13} aria-hidden="true" />}
          kbd="⌘F"
          placeholder="Search projects"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search projects"
          style={{ width: 240 }}
        />
      </div>

      <PageContentTransition className="sc-scroll" style={{ flex: 1, padding: 20 }}>
        {isLoading ? (
          <ScCard role="status" style={{ padding: 32, color: "var(--sc-text-4)" }}>
            Loading projects…
          </ScCard>
        ) : error ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              border: "1px solid oklch(0.65 0.20 22 / 0.28)",
              background: "oklch(0.65 0.20 22 / 0.10)",
              color: "oklch(0.80 0.18 22)",
              borderRadius: "var(--sc-r-lg)",
              padding: 16,
              fontSize: 13,
            }}
          >
            <AlertTriangle size={16} aria-hidden="true" />
            Failed to load projects: {String(error)}
          </div>
        ) : isEmpty ? (
          <EmptyPostProduction onGoToProjects={goToProjects} />
        ) : (
          <>
            <div
              style={{
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div className="sc-h">Pick a project</div>
              <div style={{ height: 1, flex: 1, background: "var(--sc-border)" }} />
            </div>
            <ProjectGrid
              projects={visible}
              onOpen={openProject}
              onNewStory={goToProjects}
            />
          </>
        )}
      </PageContentTransition>
    </main>
  );
}

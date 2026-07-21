import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Card as AstryxCard } from "@astryxdesign/core/Card";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { AlertTriangle, Search } from "lucide-react";
import { useMemo, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";
import { StoryEmptyState } from "@/components/empty-state/empty-state";
import { PageContentTransition } from "@/components/page-content-transition";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { filterAndSort, mostRecentTimestamp } from "@/features/dashboard/project-utils";
import { useProjects } from "@/ipc/projects";
import { relativeTime } from "@/lib/utils";
import { useDashboardStore } from "@/state/projects";

function EmptyPostProduction({ onGoToProjects }: { onGoToProjects: () => void }) {
  return (
    <StoryEmptyState
      title="No recordings yet"
      description="Record a story to start post-production."
      actions={
        <AstryxButton variant="primary" onClick={onGoToProjects} label="Go to Projects">
          Go to Projects
        </AstryxButton>
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
      <div className="story-toolbar story-window-chrome">
        <div>
          <div className="story-toolbar-title">Post-Production</div>
          <div style={{ fontSize: 11, color: "var(--color-text-disabled)", marginTop: 1 }}>
            {metaLine}
          </div>
        </div>
        <span className="story-spacer" />
        <AstryxTextInput
          ref={searchRef}
          label="Search projects"
          isLabelHidden
          startIcon={<Search size={13} aria-hidden="true" />}
          placeholder="Search projects"
          value={searchQuery}
          onChange={setSearchQuery}
          style={{ width: 240 }}
        />
      </div>

      <PageContentTransition className="story-scroll" style={{ flex: 1, padding: 20 }}>
        {isLoading ? (
          <AstryxCard role="status" style={{ padding: 32, color: "var(--color-text-disabled)" }}>
            Loading projects…
          </AstryxCard>
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
              borderRadius: "var(--radius-container)",
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
              <div className="story-section-heading">Pick a project</div>
              <div style={{ height: 1, flex: 1, background: "var(--color-border)" }} />
            </div>
            <ProjectGrid projects={visible} onOpen={openProject} onNewStory={goToProjects} />
          </>
        )}
      </PageContentTransition>
    </main>
  );
}

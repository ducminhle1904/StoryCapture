import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Card as AstryxCard } from "@astryxdesign/core/Card";
import { Kbd as AstryxKbd } from "@astryxdesign/core/Kbd";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { AlertTriangle, File, FolderOpen, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";
import { StoryEmptyState } from "@/components/empty-state/empty-state";
import { PageContentTransition } from "@/components/page-content-transition";
import { NewProjectDialog } from "@/features/dashboard/new-project-dialog";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { filterAndSort, mostRecentTimestamp } from "@/features/dashboard/project-utils";
import type { Project } from "@/ipc/projects";
import { useProjects, useRemoveProject } from "@/ipc/projects";
import { notifications } from "@/lib/notifications";
import { hasCompletedOnboarding, markOnboardingComplete } from "@/lib/onboarding";
import { relativeTime } from "@/lib/utils";
import { useDashboardStore } from "@/state/projects";

function EmptyDashboard({ onNewStory }: { onNewStory: () => void }) {
  return (
    <StoryEmptyState
      title="Write your first story"
      description="StoryCapture turns a 30-line DSL into a polished demo video. Start with a template — or paste a .story file from your repo."
      actions={
        <>
          <AstryxButton
            variant="primary"
            icon={<Plus size={13} aria-hidden="true" />}
            onClick={onNewStory}
            label="New Story"
          >
            New Story
          </AstryxButton>
          <AstryxButton
            icon={<FolderOpen size={13} aria-hidden="true" />}
            isDisabled
            tooltip="Import .story — coming soon"
            label="Import .story — coming soon"
          >
            Import .story
          </AstryxButton>
          <AstryxButton
            variant="ghost"
            icon={<File size={13} aria-hidden="true" />}
            isDisabled
            tooltip="Browse templates — coming soon"
            label="Browse templates — coming soon"
          >
            Browse templates
          </AstryxButton>
        </>
      }
    />
  );
}

export default function DashboardRoute() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects();
  const removeProject = useRemoveProject();
  const { searchQuery, sortMode, setSearchQuery } = useDashboardStore();
  const newProjectRequested = useDashboardStore((s) => s.newProjectRequested);
  const consumeNewProjectRequest = useDashboardStore((s) => s.consumeNewProjectRequest);
  const [dialogOpen, setDialogOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => filterAndSort(projects ?? [], searchQuery, sortMode),
    [projects, searchQuery, sortMode],
  );

  const openProject = (id: string) => navigate(`/editor/${id}`);
  const openNewStory = () => setDialogOpen(true);
  const removeProjectFromDashboard = async (project: Project) => {
    try {
      await removeProject.mutateAsync(project.id);
      notifications.success(`Removed ${project.name} from dashboard`);
    } catch (err) {
      notifications.error(`Could not remove project: ${String(err)}`);
      throw err;
    }
  };

  useEffect(() => {
    if (newProjectRequested) {
      setDialogOpen(true);
      consumeNewProjectRequest();
    }
  }, [newProjectRequested, consumeNewProjectRequest]);

  useEffect(() => {
    if (isLoading || error) return;
    if ((projects?.length ?? 0) > 0) {
      markOnboardingComplete();
      return;
    }
    if (!hasCompletedOnboarding()) {
      navigate("/onboarding", { replace: true });
    }
  }, [error, isLoading, navigate, projects]);

  useHotkeys(
    "mod+f",
    (e) => {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    { enableOnFormTags: true, preventDefault: true },
  );

  useEffect(() => {
    // Reset any stale focus when switching routes.
    return () => void 0;
  }, []);

  const count = projects?.length ?? 0;
  const isEmpty = !isLoading && !error && count === 0;
  const lastOpened = useMemo(() => mostRecentTimestamp(projects ?? []), [projects]);
  const metaLine = isEmpty
    ? "No stories yet"
    : `${count} ${count === 1 ? "story" : "stories"} · last opened ${relativeTime(lastOpened)}`;

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="story-toolbar story-window-chrome">
        <div>
          <div className="story-toolbar-title">Projects</div>
          <div style={{ fontSize: 11, color: "var(--color-text-disabled)", marginTop: 1 }}>
            {metaLine}
          </div>
        </div>
        <span className="story-spacer" />
        <AstryxTextInput
          ref={searchRef}
          label="Search stories"
          isLabelHidden
          startIcon={<Search size={13} aria-hidden="true" />}
          placeholder="Search stories"
          value={searchQuery}
          onChange={setSearchQuery}
          style={{ width: 240 }}
        />
        <AstryxSegmentedControl
          size="sm"
          value="all"
          isDisabled
          label="Filter by status (coming soon)"
          onChange={() => {}}
        >
          {[
            { value: "all", label: "All" },
            { value: "ready", label: "Ready" },
            { value: "rendering", label: "Rendering" },
            { value: "draft", label: "Drafts" },
          ].map((option) => (
            <AstryxSegmentedControlItem
              key={option.value}
              value={option.value}
              label={typeof option.label === "string" ? option.label : option.value}
              icon={typeof option.label === "string" ? undefined : option.label}
            />
          ))}
        </AstryxSegmentedControl>
        <AstryxButton
          variant="primary"
          icon={<Plus size={13} aria-hidden="true" />}
          endContent={<AstryxKbd keys="mod+n" />}
          onClick={openNewStory}
          aria-label="Create new story"
          label="Create new story"
        >
          New Story
        </AstryxButton>
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
          <EmptyDashboard onNewStory={openNewStory} />
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
              <div className="story-section-heading">Active</div>
              <div style={{ height: 1, flex: 1, background: "var(--color-border)" }} />
            </div>
            <ProjectGrid
              projects={visible}
              onOpen={openProject}
              onNewStory={openNewStory}
              onRemove={removeProjectFromDashboard}
              removingProjectId={removeProject.isPending ? (removeProject.variables ?? null) : null}
            />
          </>
        )}
      </PageContentTransition>

      {!isEmpty && !isLoading && !error && <RecentRenderRail />}

      <NewProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={openProject} />
    </main>
  );
}

function RecentRenderRail() {
  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        background: "var(--color-background-card)",
      }}
    >
      <div
        style={{
          padding: "12px 20px 8px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--color-text-secondary)",
          }}
        >
          Recent renders
        </div>
        <span style={{ flex: 1 }} />
        <AstryxButton
          size="sm"
          variant="ghost"
          isDisabled
          tooltip="Render history coming soon"
          label="Render history coming soon"
        >
          View all
        </AstryxButton>
      </div>
      <div
        style={{
          padding: "0 20px 16px",
          fontSize: 12,
          color: "var(--color-text-disabled)",
        }}
      >
        No recent renders yet.
      </div>
    </div>
  );
}

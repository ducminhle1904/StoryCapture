import { ScButton, ScCard, ScInput } from "@storycapture/ui";
import { AlertTriangle, ArrowRight, File, FolderOpen, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import storyToVideoEmptySrc from "@/assets/illustrations/story-to-video-empty.png";
import { EmptyState } from "@/components/empty-state/empty-state";
import { PageContentTransition } from "@/components/page-content-transition";
import { NewProjectDialog } from "@/features/dashboard/new-project-dialog";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { filterAndSort, mostRecentTimestamp } from "@/features/dashboard/project-utils";
import { useProjectDashboardSummary } from "@/features/dashboard/use-project-dashboard-summary";
import type { Project } from "@/ipc/projects";
import { useProjects, useRemoveProject } from "@/ipc/projects";
import { hasCompletedOnboarding, markOnboardingComplete } from "@/lib/onboarding";
import { relativeTime } from "@/lib/utils";
import { useDashboardStore } from "@/state/projects";

function StoryToVideoIllustration() {
  return (
    <img
      src={storyToVideoEmptySrc}
      alt=""
      aria-hidden="true"
      style={{
        display: "block",
        width: 172,
        height: 172,
        objectFit: "cover",
        borderRadius: "var(--sc-r-lg)",
        border: "1px solid var(--sc-border)",
        boxShadow: "0 18px 50px rgba(0,0,0,0.34)",
      }}
    />
  );
}

function EmptyDashboard({ onNewStory }: { onNewStory: () => void }) {
  return (
    <EmptyState
      illustration={<StoryToVideoIllustration />}
      title="Write your first story"
      body={
        <>
          StoryCapture turns a 30-line DSL into a polished demo video. Start with a template — or
          paste a <code>.story</code> file from your repo.
        </>
      }
      actions={
        <>
          <ScButton
            variant="primary"
            icon={<Plus size={13} aria-hidden="true" />}
            onClick={onNewStory}
          >
            New Story
          </ScButton>
          <ScButton
            icon={<FolderOpen size={13} aria-hidden="true" />}
            disabled
            title="Import .story — coming soon"
          >
            Import .story
          </ScButton>
          <ScButton
            variant="ghost"
            icon={<File size={13} aria-hidden="true" />}
            disabled
            title="Browse templates — coming soon"
          >
            Browse templates
          </ScButton>
        </>
      }
      footer={
        <>
          Try <span className="sc-kbd">⌘K</span> for commands.
        </>
      }
    />
  );
}

function ContinueWorking({ project }: { project: Project }) {
  const navigate = useNavigate();
  const summary = useProjectDashboardSummary(project.id);
  const hasRecording = (summary.sessionCount ?? 0) > 0;
  const target = hasRecording
    ? `/post-production/${encodeURIComponent(project.id)}`
    : `/editor/${encodeURIComponent(project.id)}`;
  const action = summary.isLoading
    ? "Open project"
    : hasRecording
      ? "Review recording"
      : "Continue authoring";

  return (
    <aside aria-labelledby="continue-working-title" className="sc-dashboard-continue">
      <div id="continue-working-title" className="sc-h">
        Continue working
      </div>
      <ScCard style={{ padding: 16 }}>
        <div className="text-[12px] text-[var(--sc-text-3)]">Most recently opened</div>
        <div className="mt-1 truncate text-[15px] font-semibold text-[var(--sc-text-1)]">
          {project.name}
        </div>
        <div className="mt-2 text-[12px] leading-5 text-[var(--sc-text-3)]">
          {summary.isLoading
            ? "Checking the latest project state…"
            : hasRecording
              ? `${summary.sessionCount} recording${summary.sessionCount === 1 ? "" : "s"} ready to review.`
              : "Keep shaping the story before recording."}
        </div>
        <ScButton
          className="mt-4 w-full justify-center"
          variant="primary"
          icon={<ArrowRight size={13} aria-hidden="true" />}
          onClick={() => navigate(target)}
        >
          {action}
        </ScButton>
      </ScCard>
    </aside>
  );
}

export default function DashboardRoute() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects();
  const removeProject = useRemoveProject();
  const { searchQuery, sortMode, setSearchQuery } = useDashboardStore();
  const newProjectRequested = useDashboardStore((s) => s.newProjectRequested);
  const newProjectDraft = useDashboardStore((s) => s.newProjectDraft);
  const consumeNewProjectRequest = useDashboardStore((s) => s.consumeNewProjectRequest);
  const clearNewProjectDraft = useDashboardStore((s) => s.clearNewProjectDraft);
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
      toast.success(`Removed ${project.name} from dashboard`);
    } catch (err) {
      toast.error(`Could not remove project: ${String(err)}`);
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
  const mostRecentProject = useMemo(
    () =>
      (projects ?? []).reduce<Project | null>((latest, project) => {
        if (!latest) return project;
        return (project.last_opened_at ?? project.created_at) >
          (latest.last_opened_at ?? latest.created_at)
          ? project
          : latest;
      }, null),
    [projects],
  );
  const metaLine = isEmpty
    ? "No stories yet"
    : `${count} ${count === 1 ? "story" : "stories"} · last opened ${relativeTime(lastOpened)}`;

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="sc-toolbar sc-window-chrome">
        <div>
          <div className="sc-toolbar-title">Projects</div>
          <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>{metaLine}</div>
        </div>
        <span className="sc-spacer" />
        <ScInput
          ref={searchRef}
          icon={<Search size={13} aria-hidden="true" />}
          kbd="⌘F"
          placeholder="Search stories"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search stories"
          style={{ width: 240 }}
        />
        <ScButton
          variant="primary"
          icon={<Plus size={13} aria-hidden="true" />}
          kbd="⌘N"
          onClick={openNewStory}
          aria-label="Create new story"
        >
          New Story
        </ScButton>
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
          <EmptyDashboard onNewStory={openNewStory} />
        ) : (
          <div className="sc-dashboard-project-layout">
            <section aria-labelledby="active-projects-title" className="min-w-0">
              <div className="mb-[10px] flex items-center gap-[10px]">
                <div id="active-projects-title" className="sc-h">
                  Active projects
                </div>
                <div className="h-px flex-1 bg-[var(--sc-border)]" />
              </div>
              <ProjectGrid
                projects={visible}
                onOpen={openProject}
                onNewStory={openNewStory}
                onRemove={removeProjectFromDashboard}
                removingProjectId={
                  removeProject.isPending ? (removeProject.variables ?? null) : null
                }
                showCreateTile={false}
              />
            </section>
            {mostRecentProject ? <ContinueWorking project={mostRecentProject} /> : null}
          </div>
        )}
      </PageContentTransition>

      <NewProjectDialog
        open={dialogOpen}
        initialDraft={newProjectDraft}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) clearNewProjectDraft();
        }}
        onCreated={openProject}
      />
    </main>
  );
}

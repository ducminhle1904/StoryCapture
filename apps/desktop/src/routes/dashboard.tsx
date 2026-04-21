import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { AlertTriangle, File, FolderOpen, Plus, Search } from "lucide-react";

import { ScButton, ScCard, ScInput, ScSegmented } from "@storycapture/ui";
import { useProjects } from "@/ipc/projects";
import { PageContentTransition } from "@/components/page-content-transition";
import { EmptyState } from "@/components/empty-state/empty-state";
import { useDashboardStore } from "@/state/projects";
import { ProjectGrid } from "@/features/dashboard/project-grid";
import { NewProjectDialog } from "@/features/dashboard/new-project-dialog";
import { relativeTime } from "@/lib/utils";

import { filterAndSort, mostRecentTimestamp } from "@/features/dashboard/project-utils";

function FilmStripsIllustration() {
  return (
    <div style={{ position: "relative", width: 160, height: 110 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            inset: `${i * 8}px ${i * 14}px`,
            background: `linear-gradient(135deg, oklch(${0.35 - i * 0.06} 0.08 78), oklch(${0.22 - i * 0.04} 0.04 78))`,
            border: "1px solid var(--sc-border-2)",
            borderRadius: 8,
            transform: `rotate(${-4 + i * 3}deg)`,
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              right: 6,
              height: 3,
              background: "oklch(0.78 0.14 78 / 0.6)",
              borderRadius: 1,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 14,
              left: 6,
              right: 30,
              height: 2,
              background: "rgba(255,255,255,0.2)",
              borderRadius: 1,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyDashboard({ onNewStory }: { onNewStory: () => void }) {
  return (
    <EmptyState
      illustration={<FilmStripsIllustration />}
      title="Write your first story"
      body={
        <>
          StoryCapture turns a 30-line DSL into a polished demo video. Start with a
          template — or paste a <code>.story</code> file from your repo.
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

export default function DashboardRoute() {
  const navigate = useNavigate();
  const { data: projects, isLoading, error } = useProjects();
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

  useEffect(() => {
    if (newProjectRequested) {
      setDialogOpen(true);
      consumeNewProjectRequest();
    }
  }, [newProjectRequested, consumeNewProjectRequest]);

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
      <div className="sc-toolbar">
        <div>
          <div className="sc-toolbar-title">Projects</div>
          <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>
            {metaLine}
          </div>
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
        <ScSegmented
          size="sm"
          value="all"
          disabled
          aria-label="Filter by status (coming soon)"
          options={[
            { value: "all", label: "All" },
            { value: "ready", label: "Ready" },
            { value: "rendering", label: "Rendering" },
            { value: "draft", label: "Drafts" },
          ]}
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
          <>
            <div
              style={{
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div className="sc-h">Active</div>
              <div style={{ height: 1, flex: 1, background: "var(--sc-border)" }} />
            </div>
            <ProjectGrid
              projects={visible}
              onOpen={openProject}
              onNewStory={openNewStory}
            />
          </>
        )}
      </PageContentTransition>

      {!isEmpty && !isLoading && !error && <RecentRenderRail />}

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={openProject}
      />
    </main>
  );
}

function RecentRenderRail() {
  return (
    <div
      style={{
        borderTop: "1px solid var(--sc-border)",
        background: "var(--sc-chrome-2)",
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
            color: "var(--sc-text-3)",
          }}
        >
          Recent renders
        </div>
        <span style={{ flex: 1 }} />
        <ScButton size="sm" variant="ghost" disabled title="Render history coming soon">
          View all
        </ScButton>
      </div>
      <div
        style={{
          padding: "0 20px 16px",
          fontSize: 12,
          color: "var(--sc-text-4)",
        }}
      >
        No recent renders yet.
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Video, AlertTriangle } from "lucide-react";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import { fetchProjectFolder, type ProjectFolderInfo } from "@/ipc/projects";
import { useEditorStore } from "@/state/editor";
import { StoryEditor } from "@/features/editor/story-editor";
import { SplitPane } from "@/features/editor/split-pane";
import { PreviewPanel } from "@/features/editor/preview-panel";
import { TimelinePanel } from "@/features/editor/timeline-panel";

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setSource = useEditorStore((s) => s.setSource);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchProjectFolder(projectId);
        if (cancelled) return;
        setFolder(info);
        const text = await readTextFile(info.story_path);
        if (!cancelled) setSource(text);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setSource]);

  const autosave = async (source: string) => {
    if (!folder) return;
    try {
      await writeTextFile(folder.story_path, source);
    } catch {
      /* surfaced in UI elsewhere if we add toast */
    }
  };

  if (loadError) {
    return (
      <main
        id="main-content"
        className="mx-auto max-w-2xl p-8"
        role="alert"
      >
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--color-fg-secondary)]">{loadError}</p>
            <Link
              to="/"
              className="mt-3 inline-flex items-center gap-1 text-[var(--color-accent-secondary)] hover:underline"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            aria-label="Back to dashboard"
            className="inline-flex items-center gap-1 rounded-md p-1 text-[var(--color-fg-secondary)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <h1 className="text-sm font-medium text-[var(--color-fg-primary)]">
            {folder?.name ?? "Loading project…"}
          </h1>
        </div>
        {projectId && (
          <Link
            to={`/recorder/${projectId}`}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent-primary)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <Video size={14} aria-hidden="true" />
            Record
          </Link>
        )}
      </header>

      <div className="flex-1 min-h-0">
        <SplitPane
          left={<StoryEditor onAutosave={autosave} />}
          right={<PreviewPanel thumbnailPath={null} />}
        />
      </div>
      <div className="h-48 min-h-0">
        <TimelinePanel />
      </div>
    </main>
  );
}

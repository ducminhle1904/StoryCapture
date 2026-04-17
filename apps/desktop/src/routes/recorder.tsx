import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { readTextFile } from "@tauri-apps/plugin-fs";

import { fetchProjectFolder, type ProjectFolderInfo } from "@/ipc/projects";
import { RecordingView } from "@/features/recorder/recording-view";

export default function RecorderRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [storySource, setStorySource] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await fetchProjectFolder(projectId);
        if (cancelled) return;
        setFolder(info);
        const src = await readTextFile(info.story_path);
        if (!cancelled) setStorySource(src);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl p-8" role="alert">
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--color-fg-secondary)]">{error}</p>
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

  if (!folder) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl p-8 text-sm text-[var(--color-fg-muted)]">
        Loading project…
      </main>
    );
  }

  return (
    <RecordingView
      projectId={projectId ?? null}
      projectName={folder.name}
      projectFolder={folder.folder_path}
      storySource={storySource}
    />
  );
}

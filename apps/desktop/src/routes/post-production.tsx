/** Route wrapper that passes `storyId` from the URL into `EditorShell`. */

import { Link, useParams } from "react-router-dom";

import { EditorShell } from "@/features/post-production/editor-shell";
import { useProjects } from "@/ipc/projects";

function PostProductionProjectChooser() {
  const projects = useProjects();

  return (
    <main id="main-content" className="sc-window-chrome h-full overflow-auto bg-[var(--sc-bg)] p-6">
      <div className="mx-auto max-w-3xl">
        <p className="text-[12px] text-[var(--sc-text-3)]">Legacy direct link</p>
        <h1 className="mt-1 text-xl font-semibold text-[var(--sc-text)]">
          Choose a project to edit
        </h1>
        <div className="mt-5 grid gap-2">
          {projects.isLoading ? <div role="status">Loading projects…</div> : null}
          {projects.error ? (
            <div role="alert">Could not load projects: {String(projects.error)}</div>
          ) : null}
          {projects.data?.map((project) => (
            <Link
              key={project.id}
              to={`/post-production/${encodeURIComponent(project.id)}`}
              className="flex items-center justify-between rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-4 py-3 text-[13px] text-[var(--sc-text)] transition-colors hover:bg-[var(--sc-surface-2)]"
            >
              <span className="font-medium">{project.name}</span>
              <span className="text-[var(--sc-text-3)]">Open Edit →</span>
            </Link>
          ))}
          {projects.isSuccess && projects.data.length === 0 ? (
            <Link to="/" className="text-[13px] text-[var(--sc-accent-400)]">
              Create a project first
            </Link>
          ) : null}
        </div>
      </div>
    </main>
  );
}

export default function PostProductionRoute() {
  const { storyId } = useParams<{ storyId: string }>();
  return storyId ? <EditorShell storyId={storyId} /> : <PostProductionProjectChooser />;
}

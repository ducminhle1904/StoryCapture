import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  File,
  FolderOpen,
  Plus,
  Scissors,
  Video,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";

import { PageContentTransition } from "@/components/page-content-transition";
import { PreviewSurface } from "@/components/preview-surface";
import { SceneListPanel } from "@/features/editor/scene-list-panel";
import {
  StoryEditor,
  type EditorJumpTarget,
} from "@/features/editor/story-editor";
import { TimelinePanel } from "@/features/editor/timeline-panel";
import { parseStory, type Story } from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo } from "@/ipc/projects";
import { useEditorStore } from "@/state/editor";

const EMPTY_DIAGNOSTICS: never[] = [];

function findSceneIndexForOffset(story: Story | null, offset: number): number {
  if (!story || story.scenes.length === 0) return 0;
  const idx = story.scenes.findIndex(
    (scene) => offset >= scene.span.start && offset <= scene.span.end,
  );
  return idx >= 0 ? idx : 0;
}


/* Editor route */

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeSceneIndex, setActiveSceneIndex] = useState(0);
  const [editorJumpTarget, setEditorJumpTarget] =
    useState<EditorJumpTarget | null>(null);
  // Only render once store state matches the URL project to avoid a stale scene flash.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);
  const resetProjectState = useEditorStore((s) => s.resetProjectState);
  const source = useEditorStore((s) => s.source);
  const story = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics =
    useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;

  useEffect(() => {
    if (!projectId) return;
    // Reset per-project state before the async load so old scenes never flash.
    resetProjectState();
    setFolder(null);
    setLoadError(null);
    setActiveSceneIndex(0);
    setLoadedProjectId(null);

    let cancelled = false;
    (async () => {
      try {
        const info = await fetchProjectFolder(projectId);
        if (cancelled) return;
        const text = await readTextFile(info.story_path);
        if (cancelled) return;
        // Parse before marking ready so the first paint already has scenes and diagnostics.
        let parsed: Awaited<ReturnType<typeof parseStory>> | null = null;
        try {
          parsed = await parseStory(text);
        } catch {
          /* Render anyway; diagnostics surface elsewhere. */
        }
        if (cancelled) return;
        // Commit folder, source, parse result, and ready flag together.
        setFolder(info);
        setSource(text);
        if (parsed) setLastParse(parsed);
        setLoadedProjectId(projectId);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setSource, setLastParse, resetProjectState]);

  const ready = loadedProjectId === projectId;

  useEffect(() => {
    if (!story || story.scenes.length === 0) {
      setActiveSceneIndex(0);
      return;
    }

    setActiveSceneIndex((current) =>
      Math.max(0, Math.min(current, story.scenes.length - 1)),
    );
  }, [story]);

  const autosave = useCallback(
    async (nextSource: string) => {
      if (!folder) return;
      try {
        await writeTextFile(folder.story_path, nextSource);
      } catch {
        /* UI handles autosave failure separately. */
      }
    },
    [folder],
  );

  const queueEditorJump = useCallback((offset: number) => {
    setEditorJumpTarget((current) => ({
      offset,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, []);

  const handleSelectScene = useCallback(
    (sceneIndex: number) => {
      setActiveSceneIndex(sceneIndex);
      const scene = story?.scenes[sceneIndex];
      if (scene) {
        queueEditorJump(scene.span.start);
      }
    },
    [queueEditorJump, story],
  );

  const handleNavigateToOffset = useCallback(
    (offset: number) => {
      setActiveSceneIndex(findSceneIndexForOffset(story, offset));
      queueEditorJump(offset);
    },
    [queueEditorJump, story],
  );

  if (loadError) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl p-8" role="alert">
        <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--sc-record)]/40 bg-[var(--sc-record)]/8 p-4 text-sm text-[var(--sc-record)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--sc-text-2)]">{loadError}</p>
            <Link
              to="/"
              className="mt-3 inline-flex items-center gap-1 text-[var(--sc-accent-400)] hover:underline"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;
  return (
    <main
      id="main-content"
      className="relative flex h-full flex-col bg-[var(--sc-bg)]"
    >
      {/* ─── Toolbar ─── */}
      <div className="sc-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link
            to="/"
            aria-label="Back to projects"
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: "var(--sc-text-2)",
              marginRight: 2,
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </Link>
          <FolderOpen size={14} style={{ color: "var(--sc-text-3)" }} aria-hidden="true" />
          <Link
            to="/"
            style={{ fontSize: 12.5, color: "var(--sc-text-3)", textDecoration: "none" }}
          >
            Projects
          </Link>
          <ChevronRight size={10} style={{ color: "var(--sc-text-4)" }} aria-hidden="true" />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {folder?.name ?? "Loading..."}
          </span>
          {errorCount > 0 && (
            <ScBadge tone="record">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </ScBadge>
          )}
          {warningCount > 0 && (
            <ScBadge tone="warn">
              {warningCount} {warningCount === 1 ? "warning" : "warnings"}
            </ScBadge>
          )}
        </div>
        <span className="sc-spacer" />
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {ready && errorCount === 0 && warningCount === 0 && (
            <ScBadge tone="muted" icon={<Check size={10} aria-hidden="true" />}>
              Lint clean
            </ScBadge>
          )}
          {projectId && (
            <>
              <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }} />
              <ScButton
                size="sm"
                icon={<Terminal size={12} aria-hidden="true" />}
              >
                Dry run
              </ScButton>
              <Link
                to={`/recorder/${projectId}`}
                className="sc-btn primary sm"
              >
                <Video size={12} aria-hidden="true" />
                Record
              </Link>
              {(folder?.session_count ?? 0) > 0 ? (
                <Link
                  to={`/post-production/${projectId}`}
                  className="sc-btn sm"
                  aria-label="Send to Post-Production"
                >
                  <Scissors size={12} aria-hidden="true" />
                  Post-Production
                </Link>
              ) : (
                <ScButton
                  size="sm"
                  disabled
                  icon={<Scissors size={12} aria-hidden="true" />}
                  aria-label="Send to Post-Production"
                  title="Record a story first"
                >
                  Post-Production
                </ScButton>
              )}
            </>
          )}
        </div>
      </div>

      {/* ─── Main workspace ─── */}
      {!ready ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center bg-[var(--sc-bg)]"
          role="status"
          aria-live="polite"
        >
          <span className="text-xs text-[var(--sc-text-4)]">
            Opening project…
          </span>
        </div>
      ) : (
      <PageContentTransition className="min-h-0 flex-1">
        <Group orientation="vertical" className="min-h-0 flex-1">
        {/* Top: scene list + script + preview + voiceover */}
        <Panel id="editor-top" defaultSize="75%" minSize="45%">
          <Group orientation="horizontal">
            {/* Scene list — narrow left panel, always visible (D-08). */}
            <Panel id="editor-scene-list" defaultSize="12%" minSize="8%" maxSize="18%">
              <SceneListPanel
                activeSceneIndex={activeSceneIndex}
                onSelectScene={handleSelectScene}
              />
            </Panel>
            <Separator className="group relative w-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

            {/* Script editor — primary workspace */}
            <Panel id="editor-script" defaultSize="54%" minSize="32%" maxSize="68%">
              <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                {/* File tabs strip — single tab reflects real single-buffer state. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: 30,
                    paddingLeft: 8,
                    background: "var(--sc-chrome-2)",
                    borderBottom: "1px solid var(--sc-border)",
                  }}
                >
                  <div
                    style={{
                      padding: "0 12px",
                      height: "100%",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--sc-surface)",
                      borderRight: "1px solid var(--sc-border)",
                      fontSize: 12,
                      color: "var(--sc-text)",
                      borderTop: "1.5px solid var(--sc-accent-400)",
                      fontFamily: "var(--sc-font-mono)",
                    }}
                  >
                    <File size={11} aria-hidden="true" />
                    {folder?.name ? `${folder.name}.story` : "story"}
                    <span
                      aria-label="Modified (placeholder)"
                      title="Modified indicator (placeholder)"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 99,
                        background: "var(--sc-text-4)",
                        marginLeft: 4,
                        opacity: 0.6,
                      }}
                    />
                  </div>
                  <ScButton
                    size="sm"
                    variant="ghost"
                    disabled
                    icon={<Plus size={11} aria-hidden="true" />}
                    title="Multi-file buffers coming soon"
                    aria-label="New tab (coming soon)"
                    style={{ marginLeft: 4 }}
                  />
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--sc-text-4)",
                      padding: "0 10px",
                      fontFamily: "var(--sc-font-mono)",
                    }}
                  >
                    Ln —, Col — · SC-DSL · UTF-8
                  </span>
                </div>

                <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-3 py-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                    Script
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-[var(--sc-text-4)]">
                    {source.split("\n").length} lines
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <StoryEditor
                    onAutosave={autosave}
                    jumpTarget={editorJumpTarget}
                  />
                </div>

                {/* Console strip — collapsed placeholder. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 28,
                    padding: "0 12px",
                    borderTop: "1px solid var(--sc-border)",
                    background: "var(--sc-surface-2)",
                    flexShrink: 0,
                    fontSize: 11,
                    color: "var(--sc-text-4)",
                    fontFamily: "var(--sc-font-mono)",
                  }}
                >
                  <Terminal size={11} aria-hidden="true" />
                  <span style={{ color: "var(--sc-text-3)", fontWeight: 500 }}>
                    Console
                  </span>
                  <span>·</span>
                  <span>Console output will appear here.</span>
                </div>
              </div>
            </Panel>

            <Separator className="group relative w-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

            {/* Right side: preview rail */}
            <Panel id="editor-preview" defaultSize="34%" minSize="24%" maxSize="44%">
              <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                {projectId ? (
                  <div className="flex items-center justify-between border-b border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-3 py-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                      Preview
                    </span>
                    <ScSegmented
                      size="sm"
                      value="desktop"
                      disabled
                      aria-label="Viewport size (coming soon)"
                      options={[
                        { value: "mobile", label: "Mobile" },
                        { value: "tablet", label: "Tablet" },
                        { value: "desktop", label: "Desktop" },
                      ]}
                    />
                  </div>
                ) : null}

                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {projectId ? (
                    <PreviewSurface mode="recording" projectId={projectId} />
                  ) : null}
                </div>
              </div>
            </Panel>
          </Group>
        </Panel>

        {/* Bottom: Timeline */}
        <Separator className="group relative h-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

        <Panel id="editor-timeline" defaultSize="22%" minSize="12%" maxSize="40%">
          <TimelinePanel onJumpTo={handleNavigateToOffset} />
        </Panel>
        </Group>
      </PageContentTransition>
      )}

    </main>
  );
}

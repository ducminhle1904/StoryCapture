import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  File,
  FolderOpen,
  Maximize2,
  Play,
  Plus,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ScBadge, ScButton, ScSegmented, ScSwitch } from "@storycapture/ui";

import { PageContentTransition } from "@/components/page-content-transition";
import { PreviewSurface } from "@/components/preview-surface";
import { LivePreview } from "@/features/recorder/live-preview";
import { SceneListPanel } from "@/features/editor/scene-list-panel";
import {
  StoryEditor,
  type EditorJumpTarget,
} from "@/features/editor/story-editor";
import { useEditorLivePreview } from "@/features/editor/use-editor-live-preview";
import { TimelinePanel } from "@/features/editor/timeline-panel";
import { parseStory, type Story } from "@/ipc/parse";
import {
  fetchProjectFolder,
  type ProjectFolderInfo,
  useProjectRecordings,
} from "@/ipc/projects";
import { useEditorStore } from "@/state/editor";

const EMPTY_DIAGNOSTICS: never[] = [];

function findSceneIndexForOffset(story: Story | null, offset: number): number {
  if (!story || story.scenes.length === 0) return 0;
  const idx = story.scenes.findIndex(
    (scene) => offset >= scene.span.start && offset <= scene.span.end,
  );
  return idx >= 0 ? idx : 0;
}

function formatRelative(ts: number): string {
  const deltaSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const m = Math.round(deltaSec / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

type ConsoleRow = { t: string; k: "info" | "success" | "warn"; m: string };

const CONSOLE_PLACEHOLDER_ROWS: ConsoleRow[] = [
  { t: "00.00", k: "info", m: 'scene "landing" started' },
  { t: "00.12", k: "info", m: "navigate → acme.test/shop (312 ms)" },
  { t: "00.44", k: "info", m: "wait page.ready → ok (144 ms)" },
  { t: "00.58", k: "success", m: "narrate queued · 7.2s · elevenlabs.rachel" },
  { t: "01.80", k: "info", m: "zoom .hero-cta → 1.8× in 1.2s" },
  { t: "03.02", k: "warn", m: "cursor path=arc · fallback to linear on headless" },
  { t: "03.20", k: "info", m: "click .hero-cta → target matched (1)" },
  { t: "03.55", k: "info", m: "transition fade 0.3s" },
];

function ConsolePane() {
  return (
    <div
      style={{
        height: 140,
        borderTop: "1px solid var(--sc-border)",
        background: "var(--sc-surface)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--sc-border)",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--sc-text-2)" }}>
          Console
        </div>
        <ScBadge tone="muted" dot>
          {CONSOLE_PLACEHOLDER_ROWS.length} events
        </ScBadge>
        <ScBadge tone="record">1 warning</ScBadge>
        <span style={{ flex: 1 }} />
        <ScButton
          size="sm"
          variant="ghost"
          icon={<Trash2 size={11} aria-hidden="true" />}
          disabled
          title="Clear console — coming soon"
        >
          Clear
        </ScButton>
      </div>
      <div
        className="sc-scroll"
        style={{
          flex: 1,
          padding: "4px 12px",
          fontFamily: "var(--sc-font-mono)",
          fontSize: 11.5,
          lineHeight: "18px",
        }}
      >
        {CONSOLE_PLACEHOLDER_ROWS.map((r, i) => (
          <div
            key={i}
            style={{ display: "grid", gridTemplateColumns: "48px 12px 1fr", gap: 8 }}
          >
            <span style={{ color: "var(--sc-text-4)" }}>{r.t}</span>
            <span
              style={{
                color:
                  r.k === "warn"
                    ? "var(--sc-warn)"
                    : r.k === "success"
                      ? "var(--sc-success)"
                      : "var(--sc-text-4)",
              }}
            >
              {r.k === "warn" ? "!" : r.k === "success" ? "✓" : "·"}
            </span>
            <span style={{ color: "var(--sc-text-2)" }}>{r.m}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


/* Editor route */

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const recordingsQuery = useProjectRecordings(projectId);
  const latest = recordingsQuery.data?.[0] ?? null;
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
  const lineCount = useMemo(() => source.split("\n").length, [source]);

  const previewEnabled = useEditorStore((s) => s.previewEnabled);
  const setPreviewEnabled = useEditorStore((s) => s.setPreviewEnabled);
  const previewViewport = useEditorStore((s) => s.previewViewport);
  const setPreviewViewport = useEditorStore((s) => s.setViewport);
  const { streamId: authorStreamId } = useEditorLivePreview(
    story?.meta?.app ?? null,
  );

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
                variant="ghost"
                icon={<SkipBack size={11} aria-hidden="true" />}
                disabled
                aria-label="Previous scene (coming soon)"
                title="Previous scene — coming soon"
              />
              <ScButton
                size="sm"
                variant="primary"
                icon={<Play size={11} aria-hidden="true" />}
                disabled
                aria-label="Run dry-run (coming soon)"
                title="Dry-run playback — coming soon"
              >
                Run
              </ScButton>
              <ScButton
                size="sm"
                variant="ghost"
                icon={<SkipForward size={11} aria-hidden="true" />}
                disabled
                aria-label="Next scene (coming soon)"
                title="Next scene — coming soon"
              />
              <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }} />
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
                    {lineCount} lines
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <StoryEditor
                    onAutosave={autosave}
                    jumpTarget={editorJumpTarget}
                  />
                </div>

                <ConsolePane />
              </div>
            </Panel>

            <Separator className="group relative w-px bg-[var(--sc-border)] transition-colors hover:bg-[var(--sc-accent-500)]/30 active:bg-[var(--sc-accent-500)]/50" />

            {/* Right side: preview rail */}
            <Panel id="editor-preview" defaultSize="34%" minSize="24%" maxSize="44%">
              <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    height: 32,
                    padding: "0 12px",
                    borderBottom: "1px solid var(--sc-border)",
                    background: "var(--sc-chrome-2)",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Live Preview</span>
                  <ScBadge tone="muted" dot>
                    {previewEnabled
                      ? authorStreamId
                        ? "live"
                        : "starting"
                      : latest
                        ? "ready"
                        : "paused"}
                  </ScBadge>
                  <span style={{ flex: 1 }} />
                  {/* Phase 09-04 D-17 — default-OFF toggle preserves cold-start. */}
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}
                    title="Launches a hidden Chromium to mirror your story as you edit."
                  >
                    <ScSwitch
                      checked={previewEnabled}
                      onCheckedChange={setPreviewEnabled}
                      aria-label="Toggle Live Preview"
                    />
                    <span>{previewEnabled ? "On" : "Off"}</span>
                  </label>
                  <ScSegmented
                    size="sm"
                    value={previewViewport}
                    onValueChange={(v) =>
                      setPreviewViewport(v as typeof previewViewport)
                    }
                    aria-label="Viewport size"
                    options={[
                      { value: "mobile", label: "Mobile" },
                      { value: "tablet", label: "Tablet" },
                      { value: "desktop", label: "Desktop" },
                    ]}
                  />
                  <ScButton
                    size="sm"
                    variant="ghost"
                    icon={<Maximize2 size={12} aria-hidden="true" />}
                    disabled
                    aria-label="Maximize preview (coming soon)"
                    title="Maximize — coming soon"
                  />
                </div>

                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {previewEnabled && authorStreamId ? (
                    <div className="flex h-full w-full items-center justify-center p-3">
                      <LivePreview streamId={authorStreamId} />
                    </div>
                  ) : projectId ? (
                    <PreviewSurface mode="recording" projectId={projectId} />
                  ) : null}
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 12px",
                    borderTop: "1px solid var(--sc-border)",
                    background: "var(--sc-surface-2)",
                    fontSize: 11,
                    color: "var(--sc-text-3)",
                    fontFamily: "var(--sc-font-mono)",
                    flexShrink: 0,
                  }}
                >
                  <ScBadge tone="muted" dot>
                    {latest ? `Latest: ${formatRelative(latest.captured_at)}` : "Idle"}
                  </ScBadge>
                  <span>
                    {latest?.width && latest.height
                      ? `${latest.width} × ${latest.height}`
                      : "1440 × 900"}
                  </span>
                  <span>·</span>
                  <span>Chromium 125</span>
                  <span>·</span>
                  <span>SCK capture</span>
                  <span style={{ flex: 1 }} />
                  <span>60 fps</span>
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

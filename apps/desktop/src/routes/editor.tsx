import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  File,
  FolderOpen,
  Scissors,
  Sparkles,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { PageContentTransition } from "@/components/page-content-transition";
import { deriveVariant, useAuthorDriverStore } from "@/features/editor/authorDriverStore";
import { EditorBreadcrumb } from "@/features/editor/editor-breadcrumb";
import { EditorCommandPalette } from "@/features/editor/editor-command-palette";
import { EditorLivePreviewPanel } from "@/features/editor/editor-live-preview-panel";
import {
  DEFAULT_POLISH_DOC,
  loadPolishDoc,
  prunePolishDocForStory,
  type StoryPolishDoc,
  savePolishDoc,
} from "@/features/editor/polish-sidecar";
import { ProblemsPanel } from "@/features/editor/problems-panel";
import { SimulatorTimeline } from "@/features/editor/simulator-timeline";
import { StoryBuilder } from "@/features/editor/story-builder";
import { type EditorJumpTarget, StoryEditor } from "@/features/editor/story-editor";
import { ensureAllStepIds, formatEditableStory } from "@/features/editor/story-ui-model";
import { useEditorLivePreview } from "@/features/editor/use-editor-live-preview";
import { parseStory } from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo, useProjectRecordings } from "@/ipc/projects";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { EMPTY_DIAGNOSTICS, useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

function showDiskConflictToast(description: string, onReload: () => void): void {
  toast.warning("Story changed on disk", {
    description,
    action: { label: "Reload", onClick: onReload },
    cancel: { label: "Keep mine", onClick: () => {} },
  });
}

/* Editor route */

export default function EditorRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const recordingsQuery = useProjectRecordings(projectId);
  const latest = recordingsQuery.data?.[0] ?? null;
  const [folder, setFolder] = useState<ProjectFolderInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorJumpTarget, setEditorJumpTarget] = useState<EditorJumpTarget | null>(null);
  const [cursor, setCursor] = useState<{ line: number; col: number } | null>(null);
  const [editorMode, setEditorMode] = useState<"ui" | "code">("ui");
  const [polish, setPolish] = useState<StoryPolishDoc>(DEFAULT_POLISH_DOC);
  const [polishReady, setPolishReady] = useState(false);
  const [polishDirty, setPolishDirty] = useState(false);
  const [recordPolishStarting, setRecordPolishStarting] = useState(false);
  const latestPolishRef = useRef(polish);
  // Only render once store state matches the URL project to avoid a stale scene flash.
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  // Snapshot of disk content from last load/save. Drives both the no-op-save
  // skip (so external edits aren't clobbered by a clean buffer) and the
  // focus-time divergence check.
  const lastDiskSourceRef = useRef<string | null>(null);
  const setSource = useEditorStore((s) => s.setSource);
  const setLastParse = useEditorStore((s) => s.setLastParse);
  const resetProjectState = useEditorStore((s) => s.resetProjectState);
  const source = useEditorStore((s) => s.source);
  const story = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;

  const previewViewport = useEditorStore((s) => s.previewViewport);
  const setPreviewViewport = useEditorStore((s) => s.setViewport);
  const {
    streamId: authorStreamId,
    appUrlValid,
    nav: previewNav,
    status: previewStatus,
  } = useEditorLivePreview(story?.meta?.app ?? null);
  const simulatorRunState = useSimulatorStore((s) => s.runState);
  const simulatorCurrentOrd = useSimulatorStore((s) => s.currentFrameOrdinal);
  // Project upstream state into the authorDriverStore so the
  // PreviewPickerButton can derive its visual variants without direct
  // coupling to either upstream store. Skipped while the local
  // projection is `picking` — the button overrides the derivation for
  // its own pick lifetime (see PreviewPickerButton onClick).
  const setAuthorDriverSnapshot = useAuthorDriverStore((s) => s.setSnapshot);
  const authorDriverVariant = useAuthorDriverStore((s) => s.variant);
  useEffect(() => {
    if (authorDriverVariant === "picking") return;
    setAuthorDriverSnapshot({
      variant: deriveVariant(authorStreamId, simulatorRunState),
      streamId: authorStreamId,
      simulatorOrdinal: simulatorRunState === "paused" ? simulatorCurrentOrd : null,
    });
  }, [
    authorStreamId,
    simulatorRunState,
    simulatorCurrentOrd,
    authorDriverVariant,
    setAuthorDriverSnapshot,
  ]);
  const simulatorFrames = useSimulatorStore((s) => s.frames);
  const showSimulatorFrame =
    simulatorRunState === "running" ||
    simulatorRunState === "paused" ||
    (simulatorRunState === "failed" && authorDriverVariant !== "picking");
  const simulatorActiveFrame =
    showSimulatorFrame && simulatorCurrentOrd != null
      ? (simulatorFrames.find((f) => f.ordinal === simulatorCurrentOrd) ?? null)
      : null;

  useEffect(() => {
    if (!projectId) return;
    // Reset per-project state before the async load so old scenes never flash.
    resetProjectState();
    setFolder(null);
    setLoadError(null);
    setLoadedProjectId(null);
    setPolish(DEFAULT_POLISH_DOC);
    setPolishReady(false);
    setPolishDirty(false);
    lastDiskSourceRef.current = null;

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
        lastDiskSourceRef.current = text;
        if (parsed) setLastParse(parsed);
        const polishDoc = await loadPolishDoc(info.story_path);
        if (cancelled) return;
        setPolish(polishDoc);
        setPolishReady(true);
        setPolishDirty(false);
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
    if (!ready || editorMode !== "ui") return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      parseStory(source)
        .then((parsed) => {
          if (!cancelled) setLastParse(parsed);
        })
        .catch(() => {});
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [editorMode, ready, source, setLastParse]);

  const autosave = useCallback(
    async (nextSource: string) => {
      if (!folder) return;
      const lastDisk = lastDiskSourceRef.current;
      // No local edits since last load/save: autosaving here would just rewrite
      // the same bytes — and worse, would clobber any external edit landed
      // since we loaded. Skip.
      if (lastDisk !== null && nextSource === lastDisk) return;
      try {
        let currentDisk: string | null = null;
        try {
          currentDisk = await readTextFile(folder.story_path);
        } catch {
          // File might be missing / unreadable; fall through and let writeText
          // either create it or surface the real error.
        }
        if (currentDisk !== null && lastDisk !== null && currentDisk !== lastDisk) {
          // Disk diverged from our snapshot — refuse to overwrite an external edit.
          const fromDisk = currentDisk;
          showDiskConflictToast("Another process modified this file. Reload from disk?", () => {
            setSource(fromDisk);
            lastDiskSourceRef.current = fromDisk;
          });
          return;
        }
        await writeTextFile(folder.story_path, nextSource);
        lastDiskSourceRef.current = nextSource;
      } catch {
        /* UI handles autosave failure separately. */
      }
    },
    [folder, setSource],
  );

  useEffect(() => {
    latestPolishRef.current = polish;
  }, [polish]);

  useEffect(() => {
    if (!folder || !polishReady || !polishDirty) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      savePolishDoc(folder.story_path, polish)
        .then(() => {
          if (!cancelled && latestPolishRef.current === polish) {
            setPolishDirty(false);
          }
        })
        .catch(() => {
          if (!cancelled) toast.error("Failed to save polish settings");
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [folder, polish, polishDirty, polishReady]);

  const updatePolish = useCallback((next: StoryPolishDoc) => {
    setPolish(next);
    setPolishDirty(true);
  }, []);

  useEffect(() => {
    if (!polishReady || !story) return;
    const pruned = prunePolishDocForStory(polish, story);
    if (!pruned.changed) return;
    setPolish(pruned.doc);
    setPolishDirty(true);
  }, [polish, polishReady, story]);

  const uiAutosave = useDebouncedCallback((nextSource: string) => {
    void autosave(nextSource);
  }, 5000);

  const handleUiSourceChange = useCallback(
    (nextSource: string) => {
      setSource(nextSource);
      uiAutosave.run(nextSource);
    },
    [setSource, uiAutosave],
  );

  const commitUiSourceChange = useCallback(
    async (nextSource: string) => {
      uiAutosave.cancel();
      setSource(nextSource);
      await autosave(nextSource);
      try {
        const parsed = await parseStory(nextSource);
        setLastParse(parsed);
      } catch {
        /* Diagnostics will refresh through the regular parse effect. */
      }
    },
    [autosave, setLastParse, setSource, uiAutosave],
  );

  const flushUiSourceChange = useCallback(() => {
    uiAutosave.flush();
  }, [uiAutosave]);

  const handleRecordAndPolish = useCallback(async () => {
    if (!projectId) return;
    setRecordPolishStarting(true);
    try {
      uiAutosave.flush();
      const parsed = await parseStory(source);
      setLastParse(parsed);
      if (parsed.ast) {
        const stamped = ensureAllStepIds(parsed.ast);
        if (stamped.changed) {
          await commitUiSourceChange(formatEditableStory(stamped.story));
        }
      }
      navigate(`/recorder/${projectId}?polish=1`);
    } finally {
      setRecordPolishStarting(false);
    }
  }, [commitUiSourceChange, navigate, projectId, setLastParse, source, uiAutosave]);

  // Reload when the window regains focus and disk drifted from our snapshot.
  // Clean buffer → silent reload; dirty buffer → prompt before discarding edits.
  useEffect(() => {
    if (!folder) return;
    let inFlight = false;
    const onFocus = async () => {
      if (inFlight) return;
      const lastDisk = lastDiskSourceRef.current;
      if (lastDisk === null) return;
      inFlight = true;
      try {
        let currentDisk: string;
        try {
          currentDisk = await readTextFile(folder.story_path);
        } catch {
          return;
        }
        if (currentDisk === lastDisk) return;
        const bufferIsClean = useEditorStore.getState().source === lastDisk;
        if (bufferIsClean) {
          setSource(currentDisk);
          lastDiskSourceRef.current = currentDisk;
          return;
        }
        const fromDisk = currentDisk;
        showDiskConflictToast("Reload from disk and discard your unsaved edits?", () => {
          setSource(fromDisk);
          lastDiskSourceRef.current = fromDisk;
        });
      } finally {
        inFlight = false;
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [folder, setSource]);

  const queueEditorJump = useCallback((offset: number) => {
    setEditorJumpTarget((current) => ({
      offset,
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, []);

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
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  const polishIntentCount = Object.keys(polish.steps).length + Object.keys(polish.scenes).length;
  return (
    <main id="main-content" className="relative flex h-full flex-col bg-[var(--sc-bg)]">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='1'/></svg>\")",
        }}
      />
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
          <span style={{ fontSize: 13, fontWeight: 600 }}>{folder?.name ?? "Loading..."}</span>
          {story && cursor && (
            <EditorBreadcrumb
              story={story}
              cursorLine={cursor.line}
              onJumpToOffset={queueEditorJump}
            />
          )}
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
          {polishReady ? (
            <ScBadge tone={polishDirty ? "warn" : "success"} dot>
              {polishDirty ? "Polish saving" : "Polish saved"}
            </ScBadge>
          ) : null}
          {projectId && (
            <>
              <Link to={`/recorder/${projectId}`} className="sc-btn primary sm">
                <Video size={12} aria-hidden="true" />
                Record
              </Link>
              <ScButton
                size="sm"
                variant="success"
                disabled={recordPolishStarting}
                icon={<Sparkles size={12} aria-hidden="true" />}
                onClick={handleRecordAndPolish}
              >
                {recordPolishStarting ? "Preparing..." : "Record with Polish"}
              </ScButton>
              {(folder?.session_count ?? 0) > 0 ? (
                <Link
                  to={`/post-production/${projectId}`}
                  className="sc-btn sm"
                  aria-label="Send to Post-Production"
                >
                  <Scissors size={12} aria-hidden="true" />
                  Fine-tune Video
                </Link>
              ) : (
                <ScButton
                  size="sm"
                  disabled
                  icon={<Scissors size={12} aria-hidden="true" />}
                  aria-label="Send to Post-Production"
                  title="Record a story first"
                >
                  Fine-tune Video
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
          <span className="text-xs text-[var(--sc-text-4)]">Opening project…</span>
        </div>
      ) : (
        <>
          <EditorCommandPalette
            story={story}
            projectFolder={folder?.folder_path ?? null}
            storyPath={folder?.story_path ?? null}
            streamId={authorStreamId}
            onJumpToOffset={queueEditorJump}
          />
          <PageContentTransition className="min-h-0 flex-1">
            <Group orientation="horizontal" className="min-h-0 flex-1">
              {/* Script editor — primary workspace */}
              <Panel id="editor-script" defaultSize="66%" minSize="42%" maxSize="76%">
                <div className="flex h-full flex-col bg-[var(--sc-surface)]">
                  {/* File tabs strip — single tab reflects real single-buffer state. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      height: 30,
                      paddingLeft: 8,
                      background: "var(--sc-chrome-2)",
                      borderBottom: "1px solid var(--sc-border-2)",
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
                        borderRight: "1px solid var(--sc-border-2)",
                        fontSize: 12,
                        color: "var(--sc-text)",
                        borderTop: "1.5px solid var(--sc-accent-400)",
                        fontFamily: "var(--sc-font-mono)",
                      }}
                    >
                      <File size={11} aria-hidden="true" />
                      {folder?.name ? `${folder.name}.story` : "story"}
                      <span
                        aria-hidden="true"
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
                    <span style={{ flex: 1 }} />
                    <ScSegmented
                      size="sm"
                      value={editorMode}
                      aria-label="Editor mode"
                      options={[
                        { value: "ui", label: "UI" },
                        { value: "code", label: "Code" },
                      ]}
                      onValueChange={(value) => setEditorMode(value as "ui" | "code")}
                    />
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--sc-text-4)",
                        padding: "0 10px",
                        fontFamily: "var(--sc-font-mono)",
                      }}
                    >
                      {cursor ? `Ln ${cursor.line}, Col ${cursor.col}` : "Ln —, Col —"} · SC-DSL ·
                      UTF-8
                    </span>
                  </div>

                  <div className="min-h-0 flex-1">
                    {editorMode === "ui" ? (
                      <StoryBuilder
                        story={story}
                        polish={polish}
                        simulatorActive={simulatorRunState === "running"}
                        storySource={source}
                        storyPath={folder?.story_path ?? null}
                        streamId={authorStreamId}
                        onSourceChange={handleUiSourceChange}
                        onSourceCommit={commitUiSourceChange}
                        onFlushSource={flushUiSourceChange}
                        onPolishChange={updatePolish}
                        onJumpToOffset={queueEditorJump}
                      />
                    ) : (
                      <StoryEditor
                        onAutosave={autosave}
                        jumpTarget={editorJumpTarget}
                        projectFolder={folder?.folder_path ?? null}
                        storyPath={folder?.story_path ?? null}
                        streamId={authorStreamId}
                        onCursorChange={setCursor}
                      />
                    )}
                  </div>

                  <ProblemsPanel onJumpToOffset={queueEditorJump} />

                  <SimulatorTimeline
                    projectFolder={folder?.folder_path ?? ""}
                    storyPath={folder?.story_path ?? ""}
                    storySource={source}
                    streamId={authorStreamId}
                    appUrlValid={appUrlValid}
                  />
                </div>
              </Panel>

              <Separator className="group relative w-px bg-[var(--sc-border-2)] shadow-[1px_0_0_var(--sc-border)] transition-colors hover:bg-[var(--sc-border-strong)] active:bg-[var(--sc-accent-500)]/50" />

              {/* Right side: preview rail */}
              <Panel id="editor-preview" defaultSize="34%" minSize="24%" maxSize="44%">
                <EditorLivePreviewPanel
                  appUrl={story?.meta?.app ?? null}
                  appUrlValid={appUrlValid}
                  authorDriverVariant={authorDriverVariant}
                  latestRecording={latest}
                  polishIntentCount={polishIntentCount}
                  previewNav={previewNav}
                  previewStatus={previewStatus}
                  previewViewport={previewViewport}
                  simulatorActiveFrame={simulatorActiveFrame}
                  simulatorRunState={simulatorRunState}
                  streamId={authorStreamId}
                  onViewportChange={setPreviewViewport}
                />
              </Panel>
            </Group>
          </PageContentTransition>
        </>
      )}
    </main>
  );
}

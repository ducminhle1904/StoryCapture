import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  File,
  FolderOpen,
  Scissors,
  Sparkles,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { parseStory, type Story } from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo, useProjectRecordings } from "@/ipc/projects";
import { notifications } from "@/lib/notifications";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { useAppSettingsStore } from "@/state/app-settings";
import { EMPTY_DIAGNOSTICS, useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulator-store";

function showDiskConflictToast(description: string, onReload: () => void): void {
  notifications.warning("Story changed on disk", {
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
  const [storyBuilderValid, setStoryBuilderValid] = useState(true);
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
  const appSettings = useAppSettingsStore((s) => s.settings);
  const story = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  const recordingBlocked = errorCount > 0 || (editorMode === "ui" && !storyBuilderValid);

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
        const [parsed, polishDoc] = await Promise.all([
          parseStory(text).catch(() => null),
          loadPolishDoc(info.story_path),
        ]);
        if (cancelled) return;
        // Commit folder, source, parse result, and ready flag together.
        setFolder(info);
        setSource(text);
        lastDiskSourceRef.current = text;
        if (parsed) setLastParse(parsed);
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
          if (!cancelled) notifications.error("Failed to save polish settings");
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

  const autosaveEnabled = appSettings?.general.autosave_enabled ?? true;
  const autosaveDelayMs = (appSettings?.general.autosave_interval_sec ?? 5) * 1000;
  const uiAutosave = useDebouncedCallback((nextSource: string) => {
    if (autosaveEnabled) void autosave(nextSource);
  }, autosaveDelayMs);

  const handleUiSourceChange = useCallback(
    (nextSource: string, optimisticStory?: Story) => {
      setSource(nextSource);
      if (optimisticStory) setLastParse({ ast: optimisticStory, diagnostics: [...diagnostics] });
      if (autosaveEnabled) uiAutosave.run(nextSource);
    },
    [autosaveEnabled, diagnostics, setLastParse, setSource, uiAutosave],
  );

  const commitUiSourceChange = useCallback(
    async (nextSource: string, optimisticStory?: Story) => {
      uiAutosave.cancel();
      setSource(nextSource);
      if (optimisticStory) setLastParse({ ast: optimisticStory, diagnostics: [...diagnostics] });
      await autosave(nextSource);
      try {
        const parsed = await parseStory(nextSource);
        setLastParse(parsed);
      } catch {
        /* Diagnostics will refresh through the regular parse effect. */
      }
    },
    [autosave, diagnostics, setLastParse, setSource, uiAutosave],
  );

  const flushUiSourceChange = useCallback(() => {
    uiAutosave.flush();
  }, [uiAutosave]);

  const handleRecordAndPolish = useCallback(async () => {
    if (!projectId || recordingBlocked) return;
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
  }, [
    commitUiSourceChange,
    navigate,
    projectId,
    recordingBlocked,
    setLastParse,
    source,
    uiAutosave,
  ]);

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
      <main id="main-content" className="story-window-chrome h-full p-8" role="alert">
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-[var(--radius-element)] border border-[var(--story-recording)]/40 bg-[var(--story-recording)]/8 p-4 text-sm text-[var(--story-recording)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5" />
          <div>
            <p className="font-medium">Failed to open project</p>
            <p className="mt-1 text-[var(--color-text-secondary)]">{loadError}</p>
            <Link
              to="/"
              className="mt-3 inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      id="main-content"
      className="relative flex h-full flex-col bg-[var(--color-background-body)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.03] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='1'/></svg>\")",
        }}
      />
      {/* ─── Toolbar ─── */}
      <div className="story-toolbar story-window-chrome">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Link
            to="/"
            aria-label="Back to projects"
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: "var(--color-text-secondary)",
              marginRight: 2,
            }}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </Link>
          <FolderOpen
            size={14}
            style={{ color: "var(--color-text-secondary)" }}
            aria-hidden="true"
          />
          <Link
            to="/"
            style={{ fontSize: 12.5, color: "var(--color-text-secondary)", textDecoration: "none" }}
          >
            Projects
          </Link>
          <ChevronRight
            size={10}
            style={{ color: "var(--color-text-disabled)" }}
            aria-hidden="true"
          />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{folder?.name ?? "Loading..."}</span>
          {story && cursor && (
            <EditorBreadcrumb
              story={story}
              cursorLine={cursor.line}
              onJumpToOffset={queueEditorJump}
            />
          )}
          {errorCount > 0 && (
            <AstryxBadge
              variant="error"
              label={`${errorCount} ${errorCount === 1 ? "error" : "errors"}`}
            />
          )}
          {warningCount > 0 && (
            <AstryxBadge
              variant="warning"
              label={`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`}
            />
          )}
        </div>
        <span className="story-spacer" />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {projectId && (
            <>
              <AstryxButton
                as={Link}
                href={`/recorder/${projectId}`}
                label="Record"
                variant="ghost"
                size="sm"
                isDisabled={recordingBlocked}
                tooltip={
                  recordingBlocked ? "Fix story validation errors before recording" : undefined
                }
                icon={<Video size={12} aria-hidden="true" />}
              >
                Record
              </AstryxButton>
              <AstryxButton
                size="sm"
                variant="primary"
                isDisabled={recordPolishStarting || recordingBlocked}
                icon={<Sparkles size={12} aria-hidden="true" />}
                onClick={handleRecordAndPolish}
                label={String(recordPolishStarting ? "Preparing..." : "Record with Polish")}
              >
                {recordPolishStarting ? "Preparing..." : "Record with Polish"}
              </AstryxButton>
              {(folder?.session_count ?? 0) > 0 ? (
                <AstryxButton
                  as={Link}
                  href={`/post-production/${projectId}`}
                  label="Fine-tune Video"
                  variant="ghost"
                  size="sm"
                  icon={<Scissors size={12} aria-hidden="true" />}
                >
                  Fine-tune Video
                </AstryxButton>
              ) : (
                <AstryxButton
                  size="sm"
                  isDisabled
                  icon={<Scissors size={12} aria-hidden="true" />}
                  aria-label="Send to Post-Production"
                  tooltip="Record a story first"
                  label="Send to Post-Production"
                >
                  Fine-tune Video
                </AstryxButton>
              )}
            </>
          )}
        </div>
      </div>

      {/* ─── Main workspace ─── */}
      {!ready ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-background-body)]"
          role="status"
          aria-live="polite"
        >
          <span className="text-xs text-[var(--color-text-disabled)]">Opening project…</span>
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
            <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-2">
              {/* Script editor — primary workspace */}
              <section
                className="min-h-0 min-w-0 overflow-hidden border-r border-[var(--color-border-emphasized)]"
                aria-label="Story"
              >
                <div className="flex h-full min-h-0 flex-col bg-[var(--color-background-surface)]">
                  {/* File tabs strip — single tab reflects real single-buffer state. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      height: 30,
                      paddingLeft: 8,
                      background: "var(--color-background-card)",
                      borderBottom: "1px solid var(--color-border-emphasized)",
                    }}
                  >
                    <div
                      style={{
                        padding: "0 12px",
                        height: "100%",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        background: "var(--color-background-surface)",
                        borderRight: "1px solid var(--color-border-emphasized)",
                        fontSize: 12,
                        color: "var(--color-text-primary)",
                        borderTop: "1.5px solid var(--color-accent)",
                        fontFamily: "var(--font-family-code)",
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
                          background: "var(--color-text-disabled)",
                          marginLeft: 4,
                          opacity: 0.6,
                        }}
                      />
                    </div>
                    <span style={{ flex: 1 }} />
                    <AstryxSegmentedControl
                      size="sm"
                      value={editorMode}
                      label="Editor mode"
                      onChange={(value) => setEditorMode(value as "ui" | "code")}
                    >
                      {[
                        { value: "ui", label: "UI" },
                        { value: "code", label: "Code" },
                      ].map((option) => (
                        <AstryxSegmentedControlItem
                          key={option.value}
                          value={option.value}
                          label={typeof option.label === "string" ? option.label : option.value}
                          icon={typeof option.label === "string" ? undefined : option.label}
                        />
                      ))}
                    </AstryxSegmentedControl>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--color-text-disabled)",
                        padding: "0 10px",
                        fontFamily: "var(--font-family-code)",
                      }}
                    >
                      {cursor ? `Ln ${cursor.line}, Col ${cursor.col}` : "Ln —, Col —"} · SC-DSL ·
                      UTF-8
                    </span>
                  </div>

                  <div className="min-h-0 flex-1 overflow-hidden">
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
                        onValidityChange={setStoryBuilderValid}
                      />
                    ) : (
                      <StoryEditor
                        onAutosave={autosave}
                        autosaveEnabled={autosaveEnabled}
                        autosaveDelayMs={autosaveDelayMs}
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
                    disabled={recordingBlocked}
                  />
                </div>
              </section>

              {/* Right side: preview rail */}
              <section className="min-h-0 min-w-0 overflow-hidden" aria-label="Live Preview">
                <EditorLivePreviewPanel
                  appUrl={story?.meta?.app ?? null}
                  appUrlValid={appUrlValid}
                  authorDriverVariant={authorDriverVariant}
                  latestRecording={latest}
                  previewNav={previewNav}
                  previewStatus={previewStatus}
                  previewViewport={previewViewport}
                  simulatorActiveFrame={simulatorActiveFrame}
                  simulatorRunState={simulatorRunState}
                  streamId={authorStreamId}
                  onViewportChange={setPreviewViewport}
                />
              </section>
            </div>
          </PageContentTransition>
        </>
      )}
    </main>
  );
}

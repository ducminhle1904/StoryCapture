import { ScButton, ScSegmented } from "@storycapture/ui";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, ArrowLeft, File, Maximize2, PanelLeftClose } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { PageContentTransition } from "@/components/page-content-transition";
import { deriveVariant, useAuthorDriverStore } from "@/features/editor/authorDriverStore";
import { EditorBreadcrumb } from "@/features/editor/editor-breadcrumb";
import { EditorCommandPalette } from "@/features/editor/editor-command-palette";
import {
  DEFAULT_EDITOR_LAYOUT,
  editorWorkspaceModeForLayout,
  readEditorLayoutPreferences,
  writeEditorLayoutPreferences,
} from "@/features/editor/editor-layout-preferences";
import { EditorLivePreviewPanel } from "@/features/editor/editor-live-preview-panel";
import {
  DEFAULT_POLISH_DOC,
  loadPolishDoc,
  prunePolishDocForStory,
  type StoryPolishDoc,
  savePolishDoc,
} from "@/features/editor/polish-sidecar";
import { ProblemsPanel, useProblemsPanelStore } from "@/features/editor/problems-panel";
import { SimulatorTimeline } from "@/features/editor/simulator-timeline";
import { StoryBuilder } from "@/features/editor/story-builder";
import { type EditorJumpTarget, StoryEditor } from "@/features/editor/story-editor";
import { ensureAllStepIds, formatEditableStory } from "@/features/editor/story-ui-model";
import { useEditorLivePreview } from "@/features/editor/use-editor-live-preview";
import type {
  ProjectStage,
  ProjectWorkflowSnapshot,
} from "@/features/project-workflow/project-stage";
import { ProjectStageHeader } from "@/features/project-workflow/project-stage-header";
import { parseStory, type Story } from "@/ipc/parse";
import { fetchProjectFolder, type ProjectFolderInfo, useProjectRecordings } from "@/ipc/projects";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { useAppSettingsStore } from "@/state/app-settings";
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
  const [recordStarting, setRecordStarting] = useState(false);
  const [storyBuilderValid, setStoryBuilderValid] = useState(true);
  const [layout, setLayout] = useState(readEditorLayoutPreferences);
  const [workspaceMode, setWorkspaceMode] = useState<"author" | "preview">(() =>
    editorWorkspaceModeForLayout(layout),
  );
  const [previewRunRequest, setPreviewRunRequest] = useState(0);
  const setProblemsOpen = useProblemsPanelStore((s) => s.setOpen);
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

  useEffect(() => {
    writeEditorLayoutPreferences(layout);
  }, [layout]);

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

  const handleRecord = useCallback(async () => {
    if (!projectId || recordingBlocked) return;
    setRecordStarting(true);
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
      navigate(`/recorder/${projectId}`);
    } finally {
      setRecordStarting(false);
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

  const latestRecordingIsValid = Boolean(latest && latest.validation?.status !== "invalid");
  const workflowSnapshot: ProjectWorkflowSnapshot = {
    storyValid: !recordingBlocked,
    previewState: simulatorRunState,
    hasValidRecording: latestRecordingIsValid,
    editState: latestRecordingIsValid ? "review" : "unavailable",
    exportReady: latestRecordingIsValid,
    exportBlockedReason: latestRecordingIsValid
      ? undefined
      : "Record a valid take before exporting.",
  };

  const selectProjectStage = (stage: ProjectStage): boolean => {
    if (stage === "author" || stage === "preview") {
      setWorkspaceMode(stage);
      setLayout((current) => ({
        ...current,
        previewFocused: stage === "preview",
        authorCollapsed: stage === "preview",
      }));
      return true;
    }
    return false;
  };

  const startEditorResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const workspace = event.currentTarget.parentElement;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const ratio = ((moveEvent.clientX - bounds.left) / bounds.width) * 100;
      setLayout((current) => ({ ...current, splitRatio: Math.min(72, Math.max(28, ratio)) }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const resizeEditorFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    setLayout((current) => ({
      ...current,
      splitRatio:
        event.key === "Home"
          ? DEFAULT_EDITOR_LAYOUT.splitRatio
          : Math.min(72, Math.max(28, current.splitRatio + (event.key === "ArrowRight" ? 2 : -2))),
    }));
  };

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
      <main id="main-content" className="sc-window-chrome h-full p-8" role="alert">
        <div className="mx-auto flex max-w-2xl items-start gap-3 rounded-[var(--radius-md)] border border-[var(--sc-record)]/40 bg-[var(--sc-record)]/8 p-4 text-sm text-[var(--sc-record)]">
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

  return (
    <main id="main-content" className="relative flex h-full flex-col bg-[var(--sc-bg)]">
      {projectId ? (
        <ProjectStageHeader
          projectId={projectId}
          projectName={folder?.name ?? "Opening project…"}
          workflowLabel={
            errorCount > 0
              ? `${errorCount} ${errorCount === 1 ? "error" : "errors"}`
              : warningCount > 0
                ? `${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`
                : "Story ready"
          }
          currentStage={workspaceMode}
          snapshot={workflowSnapshot}
          onStageChange={selectProjectStage}
          primaryAction={
            workspaceMode === "author"
              ? recordingBlocked
                ? {
                    label: "Fix issues",
                    onClick: () => {
                      setWorkspaceMode("author");
                      setLayout((current) => ({
                        ...current,
                        authorCollapsed: false,
                        previewFocused: false,
                      }));
                      setProblemsOpen(true);
                    },
                    title: "Open Problems and resolve validation errors",
                  }
                : {
                    label: recordStarting ? "Preparing…" : "Record",
                    onClick: () => void handleRecord(),
                    disabled: recordStarting,
                  }
              : simulatorRunState === "complete" && !recordingBlocked
                ? { label: "Record", onClick: () => void handleRecord(), disabled: recordStarting }
                : simulatorRunState === "running"
                  ? undefined
                  : {
                      label: simulatorRunState === "failed" ? "Retry preview" : "Run preview",
                      onClick: () => setPreviewRunRequest((current) => current + 1),
                      disabled: recordingBlocked || !appUrlValid || authorStreamId == null,
                      title: recordingBlocked
                        ? "Fix story validation errors before previewing"
                        : undefined,
                    }
          }
        />
      ) : null}

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
          <PageContentTransition className="flex min-h-0 flex-1 flex-col">
            <div
              className="sc-editor-workspace min-h-0 flex-1"
              data-editor-mode={editorMode}
              data-workspace-mode={workspaceMode}
              style={{
                gridTemplateColumns:
                  layout.authorCollapsed || layout.previewFocused
                    ? "minmax(0, 1fr)"
                    : `${layout.splitRatio}% 6px minmax(0, 1fr)`,
              }}
            >
              {/* Script editor — primary workspace */}
              {!layout.authorCollapsed && !layout.previewFocused ? (
                <section
                  className="min-h-0 min-w-0 overflow-hidden border-r border-[var(--sc-border-2)]"
                  aria-label="Story"
                >
                  <div className="flex h-full min-h-0 flex-col bg-[var(--sc-surface)]">
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
                      {story && cursor ? (
                        <EditorBreadcrumb
                          story={story}
                          cursorLine={cursor.line}
                          onJumpToOffset={queueEditorJump}
                        />
                      ) : null}
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
                      <ScButton
                        size="icon"
                        variant="ghost"
                        icon={<PanelLeftClose size={12} aria-hidden="true" />}
                        onClick={() => {
                          setWorkspaceMode("preview");
                          setLayout((current) => ({ ...current, authorCollapsed: true }));
                        }}
                        aria-label="Collapse author panel"
                        title="Collapse author panel"
                      />
                      <ScButton
                        size="icon"
                        variant="ghost"
                        icon={<Maximize2 size={12} aria-hidden="true" />}
                        onClick={() => {
                          setWorkspaceMode("preview");
                          setLayout((current) => ({
                            ...current,
                            authorCollapsed: true,
                            previewFocused: true,
                          }));
                        }}
                        aria-label="Focus preview"
                        title="Focus preview"
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
                  </div>
                </section>
              ) : null}

              {!layout.authorCollapsed && !layout.previewFocused ? (
                <hr
                  aria-label="Resize Author and Preview"
                  aria-orientation="vertical"
                  aria-valuemin={28}
                  aria-valuemax={72}
                  aria-valuenow={Math.round(layout.splitRatio)}
                  tabIndex={0}
                  onPointerDown={startEditorResize}
                  onKeyDown={resizeEditorFromKeyboard}
                  onDoubleClick={() =>
                    setLayout((current) => ({
                      ...current,
                      splitRatio: DEFAULT_EDITOR_LAYOUT.splitRatio,
                    }))
                  }
                  className="m-0 cursor-col-resize border-0 bg-[var(--sc-border)] outline-none hover:bg-[var(--sc-accent-400)] focus-visible:bg-[var(--sc-focus)]"
                />
              ) : null}

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
                  authorHidden={layout.authorCollapsed || layout.previewFocused}
                  onViewportChange={setPreviewViewport}
                  onShowAuthor={() => selectProjectStage("author")}
                />
              </section>
            </div>
            <SimulatorTimeline
              projectFolder={folder?.folder_path ?? ""}
              storyPath={folder?.story_path ?? ""}
              storySource={source}
              streamId={authorStreamId}
              appUrlValid={appUrlValid}
              disabled={recordingBlocked}
              expanded={workspaceMode === "preview"}
              runRequestId={previewRunRequest}
            />
          </PageContentTransition>
        </>
      )}
    </main>
  );
}

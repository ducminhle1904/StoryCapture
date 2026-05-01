/**
 * EditorShell. 4-pane editor layout:
 *   - Top bar (title + queue widget + export button)
 *   - Preview pane  (top-left, ~60% width)
 *   - Inspector     (top-right, ~25% width)
 *   - Timeline      (bottom, ~30% height)
 *   - Sound drawer  (left slide-out, toggled from Inspector/Sound tab)
 *   - Export modal  (dialog; mounted in DOM always, closed by default)
 *
 * Panes are sized from the persisted Zustand panels slice; splitters are
 * deferred until the resize UX matures. The grid rows/cols are computed
 * from the store so user preferences survive reloads.
 */

import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  ArrowLeft,
  Eye,
  Maximize2,
  Mic,
  MousePointer2,
  Music2,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Sparkles,
  Type,
  Volume2,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageContentTransition } from "@/components/page-content-transition";
import { PreviewSurface } from "@/components/preview-surface";
import {
  loadPolishDoc,
  prunePolishDocForStory,
  type StoryPolishDoc,
} from "@/features/editor/polish-sidecar";
import { VoiceCatalogDialog } from "@/features/voiceover/VoiceCatalogDialog";
import { useRecordingActions } from "@/ipc/actions";
import { type ParseResult, parseStory } from "@/ipc/parse";
import { fetchProjectFolder, useProjectRecordings } from "@/ipc/projects";
import { useRecordingStepTiming, useRecordingTrajectory } from "@/ipc/trajectory";
import { ExportModal } from "./export-modal/export-modal";
import { useEditorHotkeys } from "./hooks/use-hotkeys";
import { InspectorPanel } from "./inspector/inspector-panel";
import { QueueWidget } from "./render-queue/queue-widget";
import { SoundDrawer } from "./sound-browser/sound-drawer";
import { buildTimelineFromStory } from "./state/build-timeline-from-story";
import { useEditorStore } from "./state/store";
import type { AnnotationClip, ZoomClip } from "./state/timeline-slice";
import { Timeline } from "./timeline/timeline";

export interface EditorShellProps {
  storyId: string;
  videoSrc?: string;
}

function createClipId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${random}`;
}

type ReviewFixTone = "info" | "warn" | "critical";

interface ReviewFixItem {
  id: string;
  tone: ReviewFixTone;
  title: string;
  detail: string;
  targetClipId?: string;
  targetMs?: number;
}

function fixToneBadge(tone: ReviewFixTone): "info" | "warn" | "record" {
  return tone === "critical" ? "record" : tone;
}

function ReviewPanel({
  zoomCount,
  calloutCount,
  hasTrajectory,
  hasStepTiming,
  fixItems,
  recipe,
  onExport,
  onFineTune,
  onFixItem,
}: {
  zoomCount: number;
  calloutCount: number;
  hasTrajectory: boolean;
  hasStepTiming: boolean;
  fixItems: ReviewFixItem[];
  recipe: string;
  onExport: () => void;
  onFineTune: () => void;
  onFixItem: (item: ReviewFixItem) => void;
}) {
  return (
    <div className="flex h-full flex-col p-5">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles size={16} aria-hidden="true" className="text-[var(--sc-accent-400)]" />
        <div>
          <h2 className="text-sm font-semibold text-[var(--sc-text)]">Review & Export</h2>
          <p className="text-xs text-[var(--sc-text-3)]">Auto-polish recipe: {recipe}</p>
        </div>
      </div>

      <div className="grid gap-2">
        <div className="rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-3">
          <div className="text-xs text-[var(--sc-text-3)]">Generated polish</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <ScBadge tone="success">{zoomCount} zooms</ScBadge>
            <ScBadge tone="info">{calloutCount} callouts</ScBadge>
            <ScBadge tone={hasTrajectory ? "success" : "warn"}>
              {hasTrajectory ? "cursor trajectory" : "no trajectory"}
            </ScBadge>
            <ScBadge tone={hasStepTiming ? "success" : "warn"}>
              {hasStepTiming ? "step timing" : "estimated timing"}
            </ScBadge>
          </div>
        </div>

        <div className="rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-3">
          <div className="text-xs font-medium text-[var(--sc-text-2)]">Fix list</div>
          {fixItems.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--sc-text-3)]">
              No generated polish issues found.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-[var(--sc-text-3)]">
              {fixItems.map((fix) => (
                <li key={fix.id}>
                  <button
                    type="button"
                    className="grid w-full grid-cols-[auto_1fr] gap-2 rounded-[var(--sc-r-sm)] px-1 py-1 text-left hover:bg-[var(--sc-surface-3)] hover:text-[var(--sc-text)]"
                    onClick={() => onFixItem(fix)}
                  >
                    <ScBadge tone={fixToneBadge(fix.tone)}>{fix.tone}</ScBadge>
                    <span className="min-w-0">
                      <span className="block font-medium text-[var(--sc-text-2)]">{fix.title}</span>
                      <span className="block text-[var(--sc-text-4)]">{fix.detail}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <span className="flex-1" />
      <div className="flex gap-2">
        <ScButton size="sm" variant="ghost" onClick={onFineTune}>
          Fine tune timeline
        </ScButton>
        <ScButton size="sm" variant="success" onClick={onExport}>
          Export
        </ScButton>
      </div>
    </div>
  );
}

function clipIdForStep(
  stepId: string | null | undefined,
  zoomClips: readonly ZoomClip[],
  annotationClips: readonly AnnotationClip[],
): string | undefined {
  if (!stepId) return undefined;
  return (
    zoomClips.find((clip) => clip.id.endsWith(`-${stepId}`))?.id ??
    annotationClips.find((clip) => clip.id.endsWith(`-${stepId}`))?.id
  );
}

export function EditorShell({ storyId, videoSrc }: EditorShellProps) {
  const timelineHeightPct = useEditorStore((s) => s.timelineHeightPct);
  const previewWidthPct = useEditorStore((s) => s.previewWidthPct);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const setExportModalOpen = useEditorStore((s) => s.setExportModalOpen);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const pushAction = useEditorStore((s) => s.pushAction);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const zoomClips = useEditorStore((s) => s.tracks.zoom);
  const annotationClips = useEditorStore((s) => s.tracks.annotations);

  // Wire the latest project recording into the preview canvas. Explicit
  // `videoSrc` prop (used by tests/storybook) wins over the IPC-loaded path.
  const recordingsQuery = useProjectRecordings(storyId);
  const latestRecording = recordingsQuery.data?.[0] ?? null;
  const resolvedVideoSrc = videoSrc ?? latestRecording?.path;
  const showEmptyOverlay = !videoSrc && recordingsQuery.isSuccess && !latestRecording;
  const showErrorOverlay = !videoSrc && recordingsQuery.isError;

  // Phase 19-03: load + parse the project's `.story` source so producer
  // can populate the timeline. We mirror the editor route's load pattern
  // (open_project IPC → fs.readTextFile → parseStory) instead of duplicating
  // it in a new IPC. Parse failure is non-fatal: we still build a video clip.
  const [storyParsed, setStoryParsed] = useState<ParseResult | null>(null);
  const [polishDoc, setPolishDoc] = useState<StoryPolishDoc | null>(null);
  const [projectOpenReady, setProjectOpenReady] = useState(Boolean(videoSrc));
  const [timelineBootstrapReady, setTimelineBootstrapReady] = useState(Boolean(videoSrc));
  const [workspaceMode, setWorkspaceMode] = useState<"review" | "fine-tune">("review");
  useEffect(() => {
    let cancelled = false;
    setStoryParsed(null);
    setPolishDoc(null);
    setProjectOpenReady(Boolean(videoSrc));
    setTimelineBootstrapReady(Boolean(videoSrc));
    (async () => {
      try {
        const info = await fetchProjectFolder(storyId);
        if (cancelled) return;
        setProjectOpenReady(true);
        const polishPromise = loadPolishDoc(info.story_path);
        const storyPromise = readTextFile(info.story_path).then((text) => parseStory(text));
        const loadedPolish = await polishPromise;
        if (cancelled) return;
        setPolishDoc(loadedPolish);
        try {
          const parsed = await storyPromise;
          if (cancelled) return;
          setStoryParsed(parsed);
        } finally {
          if (!cancelled) setTimelineBootstrapReady(true);
        }
      } catch {
        /* Best-effort. Producer falls back to recording-only timeline. */
        if (!cancelled && videoSrc) {
          setProjectOpenReady(true);
        }
        if (!cancelled) setTimelineBootstrapReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyId, videoSrc]);

  const actionsQuery = useRecordingActions(latestRecording?.path);
  const trajectoryQuery = useRecordingTrajectory(
    latestRecording?.path,
    actionsQuery.isSuccess && actionsQuery.data === null,
  );
  const stepTimingQuery = useRecordingStepTiming(latestRecording?.path);
  const hasCursorData = Boolean(actionsQuery.data || trajectoryQuery.data);

  // One-shot auto-populate: only run while generated tracks are empty so we
  // don't clobber persisted user edits. Idempotent on identical inputs.
  const setTracks = useEditorStore((s) => s.setTracks);
  const tracksVideoLen = useEditorStore((s) => s.tracks.video.length);
  const tracksCursorLen = useEditorStore((s) => s.tracks.cursor.length);
  const tracksZoomLen = useEditorStore((s) => s.tracks.zoom.length);
  const tracksSoundLen = useEditorStore((s) => s.tracks.sound.length);
  const tracksAnnotationLen = useEditorStore((s) => s.tracks.annotations.length);
  const reviewFixItems = useMemo(() => {
    const fixes: ReviewFixItem[] = [];
    const timing = stepTimingQuery.data;
    if (!timing) {
      fixes.push({
        id: "missing-step-timing",
        tone: "warn",
        title: "Estimated step timing",
        detail: "No step timing sidecar was found; generated clips use fallback spacing.",
      });
    } else if (timing.status !== "completed") {
      fixes.push({
        id: `timing-status-${timing.status}`,
        tone: timing.status === "failed" ? "critical" : "warn",
        title: "Partial timing sidecar",
        detail: `Recording timing ended as ${timing.status}; review generated clip positions.`,
        targetMs: timing.steps.at(-1)?.endMs,
      });
    }
    if (!hasCursorData) {
      fixes.push({
        id: "missing-trajectory",
        tone: "warn",
        title: "Missing cursor data",
        detail:
          "Zoom centers may use defaults because action and trajectory sidecars are unavailable.",
      });
    }
    if (tracksZoomLen > 10) {
      fixes.push({
        id: "dense-zooms",
        tone: "info",
        title: "Dense zoom pacing",
        detail: "More than 10 zooms were generated; inspect the first scripted zoom.",
        targetClipId: zoomClips[0]?.id,
        targetMs: zoomClips[0]?.startMs,
      });
    }
    if (tracksAnnotationLen === 0) {
      fixes.push({
        id: "missing-callouts",
        tone: "info",
        title: "No callouts",
        detail: "No callout text was declared in Editor UI mode.",
      });
    }
    const lowConfidenceStep = timing?.steps.find((step) => step.confidence === "low");
    if (lowConfidenceStep) {
      fixes.push({
        id: `low-confidence-${lowConfidenceStep.ordinal}`,
        tone: "critical",
        title: "Low-confidence timing",
        detail: `${lowConfidenceStep.sceneName} step ${lowConfidenceStep.ordinal} needs review.`,
        targetClipId: clipIdForStep(lowConfidenceStep.stepId, zoomClips, annotationClips),
        targetMs: lowConfidenceStep.startMs,
      });
    }
    const missingGeometryStep = timing?.steps.find((step) => step.target && !step.target.bbox);
    if (missingGeometryStep) {
      fixes.push({
        id: `missing-geometry-${missingGeometryStep.ordinal}`,
        tone: "warn",
        title: "Missing target geometry",
        detail: `${missingGeometryStep.sceneName} step ${missingGeometryStep.ordinal} has selector timing but no bbox.`,
        targetClipId: clipIdForStep(missingGeometryStep.stepId, zoomClips, annotationClips),
        targetMs: missingGeometryStep.startMs,
      });
    }
    const orphanStepId =
      polishDoc && storyParsed
        ? prunePolishDocForStory(polishDoc, storyParsed.ast).removedStepIds[0]
        : null;
    if (orphanStepId) {
      fixes.push({
        id: `orphan-polish-${orphanStepId}`,
        tone: "warn",
        title: "Orphan polish entry",
        detail: "A polish setting points to a deleted or unstamped step.",
      });
    }
    return fixes;
  }, [
    annotationClips,
    polishDoc,
    stepTimingQuery.data,
    storyParsed,
    tracksAnnotationLen,
    tracksZoomLen,
    hasCursorData,
    zoomClips,
  ]);
  useEffect(() => {
    if (!latestRecording) return;
    if (!timelineBootstrapReady) return;
    if (actionsQuery.isLoading || trajectoryQuery.isLoading || stepTimingQuery.isLoading) return;
    if (tracksVideoLen > 0) return;
    if (tracksCursorLen > 0 || tracksZoomLen > 0 || tracksSoundLen > 0 || tracksAnnotationLen > 0) {
      return;
    }
    const built = buildTimelineFromStory({
      story: storyParsed,
      recording: latestRecording,
      actions: actionsQuery.data ?? null,
      trajectory: trajectoryQuery.data ?? null,
      polish: polishDoc,
      stepTiming: stepTimingQuery.data ?? null,
    });
    const { background, ...builtTracks } = built;
    setTracks(builtTracks);
    useEditorStore.setState((state) => ({
      _undoExtras: {
        graphSnapshot: state._undoExtras?.graphSnapshot ?? {},
        textOverlays: state._undoExtras?.textOverlays ?? {},
        background,
      },
    }));
  }, [
    latestRecording,
    polishDoc,
    storyParsed,
    actionsQuery.data,
    actionsQuery.isLoading,
    stepTimingQuery.data,
    stepTimingQuery.isLoading,
    timelineBootstrapReady,
    trajectoryQuery.data,
    trajectoryQuery.isLoading,
    tracksVideoLen,
    tracksCursorLen,
    tracksZoomLen,
    tracksSoundLen,
    tracksAnnotationLen,
    setTracks,
  ]);

  const handleReviewFixItem = useCallback(
    (item: ReviewFixItem) => {
      setWorkspaceMode("fine-tune");
      if (typeof item.targetMs === "number") setPlayhead(item.targetMs);
      if (item.targetClipId) {
        setSelectedClipId(item.targetClipId);
        setSelectedTab("effects");
      }
    },
    [setPlayhead, setSelectedClipId, setSelectedTab],
  );

  useEditorHotkeys();

  // Set a default duration so the timeline ruler has visible ticks on
  // first mount. Real durations will flow from loaded stories in P13.
  const setDuration = useEditorStore((s) => s.setDuration);
  useEffect(() => {
    if (useEditorStore.getState().durationMs === 0) {
      setDuration(60_000);
    }
  }, [setDuration]);

  const topHeightPct = 100 - timelineHeightPct;
  const inspectorWidthPct = 100 - previewWidthPct;
  const effectiveTopHeightPct = workspaceMode === "review" ? 100 : topHeightPct;

  const addZoomAtPlayhead = useCallback(() => {
    const clip: ZoomClip = {
      id: createClipId("zoom"),
      trackId: "zoom",
      startMs: playheadMs,
      durationMs: 1_000,
      label: "Zoom 1.5x",
      target: { kind: "cursor" },
      scale: 1.5,
      center: { x: 0.5, y: 0.5 },
      preset: "DYNAMIC",
    };
    pushAction({ kind: "add-clip", trackId: "zoom", clip });
    setSelectedClipId(clip.id);
    setSelectedTab("effects");
  }, [playheadMs, pushAction, setSelectedClipId, setSelectedTab]);

  const addTextAtPlayhead = useCallback(() => {
    const clip: AnnotationClip = {
      id: createClipId("text"),
      trackId: "annotations",
      startMs: playheadMs,
      durationMs: 1_000,
      label: "Title",
      text: "Title",
      pos: { x: 0.5, y: 0.9 },
      sizePt: 24,
      color: "#ffffff",
    };
    pushAction({ kind: "add-clip", trackId: "annotations", clip });
    setSelectedClipId(clip.id);
    setSelectedTab("effects");
  }, [playheadMs, pushAction, setSelectedClipId, setSelectedTab]);

  const inspectorContent = !projectOpenReady ? (
    <div role="status" className="p-5 text-sm text-[var(--sc-text-3)]">
      Loading project…
    </div>
  ) : workspaceMode === "review" ? (
    <ReviewPanel
      zoomCount={tracksZoomLen}
      calloutCount={tracksAnnotationLen}
      hasTrajectory={hasCursorData}
      hasStepTiming={Boolean(stepTimingQuery.data)}
      fixItems={reviewFixItems}
      recipe={polishDoc?.global.recipe ?? "dynamic"}
      onExport={() => setExportModalOpen(true)}
      onFineTune={() => setWorkspaceMode("fine-tune")}
      onFixItem={handleReviewFixItem}
    />
  ) : (
    <InspectorPanel />
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-[var(--sc-bg)] text-[var(--sc-text)]"
      data-editor-shell="true"
      data-story-id={storyId}
    >
      {/* Top bar */}
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
          <Scissors size={14} style={{ color: "var(--sc-text-3)" }} aria-hidden="true" />
          <div className="sc-toolbar-title">Post-Production</div>
          <ScBadge tone="muted">story {storyId}</ScBadge>
        </div>
        <span className="sc-spacer" />
        <ScSegmented
          size="sm"
          value={workspaceMode}
          aria-label="Post-production mode"
          options={[
            { value: "review", label: "Review" },
            { value: "fine-tune", label: "Fine tune" },
          ]}
          onValueChange={(value) => setWorkspaceMode(value as "review" | "fine-tune")}
        />
        <ScButton
          size="sm"
          variant="ghost"
          icon={<Sparkles size={12} aria-hidden="true" />}
          disabled
          title="AI pass coming soon"
        >
          AI pass
        </ScButton>
        <ScButton
          size="sm"
          variant="ghost"
          icon={<Eye size={12} aria-hidden="true" />}
          disabled
          title="Fullscreen preview coming soon"
        >
          Preview
        </ScButton>
        <div
          style={{
            width: 1,
            height: 18,
            background: "var(--sc-border)",
            margin: "0 4px",
          }}
          aria-hidden="true"
        />
        <ScButton
          size="sm"
          icon={<Music2 size={12} aria-hidden="true" />}
          onClick={() => setSoundDrawerOpen(true)}
          aria-label="Open sound library"
        >
          Sounds
        </ScButton>
        {projectOpenReady ? (
          <QueueWidget storyId={storyId} />
        ) : (
          <ScBadge tone="muted">0 queue</ScBadge>
        )}
        <ScButton
          variant="success"
          size="sm"
          onClick={() => setExportModalOpen(true)}
          aria-label="Open export dialog"
        >
          Export
        </ScButton>
      </div>

      <PageContentTransition className="min-h-0 flex-1">
        {/* Top region: preview | inspector */}
        <div
          className="flex min-h-0 gap-5 px-5 py-5"
          style={{ height: `${effectiveTopHeightPct}%` }}
        >
          <section
            className="min-w-0 overflow-hidden rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
            style={{
              width: `${previewWidthPct}%`,
              display: "flex",
              flexDirection: "column",
            }}
            aria-label="Preview"
          >
            {/* Canvas sub-toolbar — placeholder */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px",
                borderBottom: "1px solid var(--sc-border)",
                background: "var(--sc-chrome)",
                height: 36,
                flexShrink: 0,
              }}
            >
              <ScSegmented
                size="sm"
                value="fit"
                disabled
                aria-label="Canvas zoom (coming soon)"
                options={[
                  { value: "fit", label: "Fit" },
                  { value: "100", label: "100%" },
                  { value: "zoom", label: "Zoom" },
                ]}
              />
              <div style={{ width: 1, height: 16, background: "var(--sc-border)" }} />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<MousePointer2 size={12} aria-hidden="true" />}
                title="Cursor overlay — coming soon"
                aria-label="Cursor overlay"
              />
              <ScButton
                size="sm"
                variant="ghost"
                icon={<ZoomIn size={12} aria-hidden="true" />}
                title="Add zoom keyframe"
                aria-label="Add zoom clip"
                onClick={addZoomAtPlayhead}
              >
                + Zoom
              </ScButton>
              <ScButton
                size="sm"
                variant="ghost"
                icon={<Type size={12} aria-hidden="true" />}
                title="Add text annotation"
                aria-label="Add text clip"
                onClick={addTextAtPlayhead}
              >
                + Text
              </ScButton>
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Sparkles size={12} aria-hidden="true" />}
                title="AI auto-zoom — coming soon"
                aria-label="AI auto-zoom"
              />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Mic size={12} aria-hidden="true" />}
                title="Voiceover overlay — coming soon"
                aria-label="Voiceover overlay"
              />
              <span style={{ flex: 1 }} />
              <span
                style={{
                  fontSize: 11,
                  color: "var(--sc-text-4)",
                  fontFamily: "var(--sc-font-mono)",
                }}
              >
                — × — · — fps
              </span>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
              <PreviewSurface mode="composited" storyId={storyId} videoSrc={resolvedVideoSrc} />
              {(showEmptyOverlay || showErrorOverlay) && (
                <div
                  className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
                  role="status"
                >
                  <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-2 rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]/90 px-5 py-4 text-center backdrop-blur">
                    <div className="text-[12px] font-medium text-[var(--sc-text-2)]">
                      {showErrorOverlay ? "Couldn't load recordings" : "No recording yet"}
                    </div>
                    <Link to={`/recorder/${storyId}`} className="sc-btn primary sm">
                      Record one first
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                background: "var(--sc-chrome)",
                borderTop: "1px solid var(--sc-border)",
                flexShrink: 0,
              }}
            >
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<SkipBack size={12} aria-hidden="true" />}
                title="Shell transport — coming soon"
                aria-label="Previous scene"
              />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Play size={11} aria-hidden="true" />}
                title="Shell transport — coming soon"
                aria-label="Play"
              />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Pause size={11} aria-hidden="true" />}
                title="Shell transport — coming soon"
                aria-label="Pause"
              />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<SkipForward size={12} aria-hidden="true" />}
                title="Shell transport — coming soon"
                aria-label="Next scene"
              />
              <div
                style={{
                  fontFamily: "var(--sc-font-mono)",
                  fontSize: 12,
                  color: "var(--sc-text-4)",
                  letterSpacing: "0.02em",
                  minWidth: 130,
                }}
              >
                —:—:— / —:—:—
              </div>
              <span style={{ flex: 1 }} />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Volume2 size={12} aria-hidden="true" />}
                title="Volume — coming soon"
                aria-label="Volume"
              />
              <ScButton
                size="sm"
                variant="ghost"
                disabled
                icon={<Maximize2 size={12} aria-hidden="true" />}
                title="Fullscreen — coming soon"
                aria-label="Fullscreen"
              />
            </div>
          </section>
          <section
            className="min-w-0 overflow-hidden rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
            style={{ width: `${inspectorWidthPct}%` }}
          >
            {inspectorContent}
          </section>
        </div>

        {/* Bottom region: timeline */}
        {workspaceMode === "fine-tune" && (
          <section
            className="mx-5 mb-5 shrink-0 overflow-hidden rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
            style={{ height: `${timelineHeightPct}%` }}
            aria-label="Timeline area"
          >
            <Timeline storyId={storyId} />
          </section>
        )}
      </PageContentTransition>

      <SoundDrawer />
      <ExportModal storyId={storyId} />
      <VoiceCatalogDialog projectId={storyId} />
    </div>
  );
}

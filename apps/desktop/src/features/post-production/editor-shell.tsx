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
  CheckCircle2,
  Clock3,
  Music2,
  Scissors,
  Sparkles,
  TriangleAlert,
  Type,
  Wand2,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
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
import { fetchProjectFolder, type RecordingInfo, useProjectRecordings } from "@/ipc/projects";
import { timelineLoad, timelineSave } from "@/ipc/timeline";
import { useRecordingStepTiming, useRecordingTrajectory } from "@/ipc/trajectory";
import { ExportModal } from "./export-modal/export-modal";
import { useEditorHotkeys } from "./hooks/use-hotkeys";
import { InspectorPanel } from "./inspector/inspector-panel";
import { QueueWidget } from "./render-queue/queue-widget";
import { SoundDrawer } from "./sound-browser/sound-drawer";
import {
  buildTimelineFromStory,
  mergeIndependentAnnotations,
  recordingSourceRevision,
} from "./state/build-timeline-from-story";
import { createClipId } from "./state/clip-id";
import { DEFAULT_BACKGROUND, readEditorBackground, useEditorStore } from "./state/store";
import { styleDefaults } from "./state/text-style";
import {
  parseTimelineLayoutJson,
  serializeTimelineLayout,
  type TimelineLayoutV2,
} from "./state/timeline-layout";
import {
  type AnnotationClip,
  cloneTimelineTracks,
  type TimelineSlice,
  type ZoomClip,
} from "./state/timeline-slice";
import { Timeline } from "./timeline/timeline";

export interface EditorShellProps {
  storyId: string;
  videoSrc?: string;
}

function maxTrackEndMs(tracks: TimelineSlice["tracks"]): number {
  let maxEndMs = 0;
  for (const clips of Object.values(tracks)) {
    for (const clip of clips) {
      maxEndMs = Math.max(maxEndMs, clip.startMs + clip.durationMs);
    }
  }
  return maxEndMs;
}

function resetTransientTimelineState() {
  useEditorStore.setState({
    tracks: cloneTimelineTracks(),
    durationMs: 0,
    playheadMs: 0,
    selectedClipId: null,
    selectedPresetId: null,
    selectedTab: "presets",
    _undoExtras: {
      graphSnapshot: {},
      textOverlays: {},
      background: DEFAULT_BACKGROUND,
    },
  });
  useEditorStore.getState().clearHistory();
}

function serializeCurrentTimelineLayout(): string {
  const state = useEditorStore.getState();
  return serializeTimelineLayout({
    tracks: state.tracks,
    durationMs: state.durationMs,
    background: readEditorBackground(state),
  });
}

function timelineLayoutMatchesRecording(
  layout: TimelineLayoutV2,
  recording: RecordingInfo,
): boolean {
  return (
    layout.sourceRevision === recordingSourceRevision(recording) &&
    layout.tracks.video.some((clip) => clip.sourcePath === recording.path)
  );
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

function fixToneIcon(tone: ReviewFixTone) {
  if (tone === "critical") {
    return <TriangleAlert size={14} aria-hidden="true" className="text-[var(--sc-record)]" />;
  }
  if (tone === "warn") {
    return <Clock3 size={14} aria-hidden="true" className="text-[var(--sc-warn)]" />;
  }
  return <CheckCircle2 size={14} aria-hidden="true" className="text-[var(--sc-accent-400)]" />;
}

function ReviewPanel({
  zoomCount,
  calloutCount,
  soundCount,
  videoCount,
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
  soundCount: number;
  videoCount: number;
  hasTrajectory: boolean;
  hasStepTiming: boolean;
  fixItems: ReviewFixItem[];
  recipe: string;
  onExport: () => void;
  onFineTune: () => void;
  onFixItem: (item: ReviewFixItem) => void;
}) {
  const criticalCount = fixItems.filter((item) => item.tone === "critical").length;
  const readyToExport = criticalCount === 0 && videoCount > 0;
  const statusTitle = readyToExport ? "Ready For A Final Pass" : "Review Needed Before Export";
  const statusDetail = readyToExport
    ? "Generated polish is available. Scrub the preview, then export or fine-tune individual clips."
    : "Start with the items below. Each row jumps to the relevant timeline moment when available.";

  return (
    <div className="flex h-full flex-col overflow-auto p-4">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" className="text-[var(--sc-accent-400)]" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sc-text-3)]">
            Review Pass
          </span>
        </div>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-[var(--sc-text)]">
          {statusTitle}
        </h2>
        <p className="mt-1 text-sm leading-5 text-[var(--sc-text-3)]">{statusDetail}</p>
      </div>

      <div className="grid gap-2">
        <section className="border-t border-[var(--sc-border-2)] py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-[var(--sc-text-2)]">
                Editor Polish Recipe
              </div>
              <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--sc-text-4)]">
                {recipe}
              </div>
            </div>
            <ScBadge tone={readyToExport ? "success" : "warn"}>
              {readyToExport ? "Exportable" : "Needs Review"}
            </ScBadge>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-sm">
            <div>
              <div className="font-mono text-base text-[var(--sc-text)]">{videoCount}</div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                Video
              </div>
            </div>
            <div>
              <div className="font-mono text-base text-[var(--sc-text)]">{zoomCount}</div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                Zooms
              </div>
            </div>
            <div>
              <div className="font-mono text-base text-[var(--sc-text)]">{calloutCount}</div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                Callouts
              </div>
            </div>
            <div>
              <div className="font-mono text-base text-[var(--sc-text)]">{soundCount}</div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                Audio
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--sc-border-2)] pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-[var(--sc-text-2)]">Review Checklist</div>
            <div className="flex gap-1">
              <ScBadge tone={hasStepTiming ? "success" : "warn"}>
                {hasStepTiming ? "Timed" : "Step Timing Missing"}
              </ScBadge>
              <ScBadge tone={hasTrajectory ? "success" : "warn"}>
                {hasTrajectory ? "Cursor" : "No Cursor"}
              </ScBadge>
            </div>
          </div>
          {fixItems.length === 0 ? (
            <div className="border-l border-[var(--sc-success)]/50 pl-3 text-sm text-[var(--sc-text-3)]">
              No generated polish issues found. Use Fine tune for visual adjustments or export now.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--sc-border-2)] text-sm">
              {fixItems.map((fix) => (
                <li key={fix.id}>
                  <button
                    type="button"
                    className="grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 py-2.5 text-left transition-[background-color,transform] hover:bg-[var(--sc-surface-2)] active:scale-[0.99]"
                    onClick={() => onFixItem(fix)}
                  >
                    <span className="mt-0.5">{fixToneIcon(fix.tone)}</span>
                    <span className="min-w-0">
                      <span className="block font-medium text-[var(--sc-text-2)]">{fix.title}</span>
                      <span className="mt-0.5 block text-xs leading-4 text-[var(--sc-text-4)]">
                        {fix.detail}
                      </span>
                    </span>
                    <ScBadge tone={fixToneBadge(fix.tone)}>{fix.tone.toUpperCase()}</ScBadge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <span className="flex-1" />
      <div className="mt-5 grid grid-cols-2 gap-2">
        <ScButton
          size="sm"
          variant="ghost"
          icon={<Wand2 size={12} aria-hidden="true" />}
          onClick={onFineTune}
        >
          Fine Tune
        </ScButton>
        <ScButton size="sm" variant="success" onClick={onExport} disabled={!readyToExport}>
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
  const previewWidthPct = useEditorStore((s) => s.previewWidthPct);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const setExportModalOpen = useEditorStore((s) => s.setExportModalOpen);
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
  const latestRecordingInvalid = latestRecording?.validation?.status === "invalid";
  const recordingsReady = Boolean(videoSrc) || recordingsQuery.isSuccess || recordingsQuery.isError;
  const resolvedVideoSrc = videoSrc ?? (latestRecordingInvalid ? undefined : latestRecording?.path);
  const showEmptyOverlay = !videoSrc && recordingsQuery.isSuccess && !latestRecording;
  const showErrorOverlay = !videoSrc && recordingsQuery.isError;
  const showInvalidOverlay = !videoSrc && latestRecordingInvalid;
  const recordingOverlayMessage = showErrorOverlay
    ? "Couldn't load recordings"
    : showInvalidOverlay
      ? "Latest recording is invalid"
      : showEmptyOverlay
        ? "No recording yet"
        : null;

  // Phase 19-03: load + parse the project's `.story` source so producer
  // can populate the timeline. We mirror the editor route's load pattern
  // (open_project IPC → fs.readTextFile → parseStory) instead of duplicating
  // it in a new IPC. Parse failure is non-fatal: we still build a video clip.
  const [storyParsed, setStoryParsed] = useState<ParseResult | null>(null);
  const [polishDoc, setPolishDoc] = useState<StoryPolishDoc | null>(null);
  const [projectOpenReady, setProjectOpenReady] = useState(Boolean(videoSrc));
  const [timelineBootstrapReady, setTimelineBootstrapReady] = useState(Boolean(videoSrc));
  const [timelineHydrated, setTimelineHydrated] = useState(Boolean(videoSrc));
  const [timelineNeedsBootstrap, setTimelineNeedsBootstrap] = useState(Boolean(videoSrc));
  const [workspaceMode, setWorkspaceMode] = useState<"review" | "fine-tune">("review");
  const timelineLoadTokenRef = useRef(0);
  const lastSavedTimelineRef = useRef("");
  const staleIndependentAnnotationsRef = useRef<AnnotationClip[]>([]);
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

  useEffect(() => {
    const token = ++timelineLoadTokenRef.current;
    setTimelineHydrated(false);
    setTimelineNeedsBootstrap(false);
    lastSavedTimelineRef.current = "";
    staleIndependentAnnotationsRef.current = [];
    resetTransientTimelineState();

    if (videoSrc) {
      setTimelineHydrated(true);
      setTimelineNeedsBootstrap(true);
      return;
    }
    if (!recordingsReady) return;

    (async () => {
      try {
        const saved = await timelineLoad(storyId);
        if (timelineLoadTokenRef.current !== token) return;
        if (saved?.layout_json) {
          const parsed = parseTimelineLayoutJson(saved.layout_json);
          if (parsed.ok) {
            const staleForLatestRecording = latestRecording
              ? !timelineLayoutMatchesRecording(parsed.layout, latestRecording)
              : recordingsQuery.isSuccess;
            if (staleForLatestRecording) {
              staleIndependentAnnotationsRef.current = parsed.layout.tracks.annotations.filter(
                (clip) => !clip.syncGroupId,
              );
              console.info(
                `Saved timeline for story ${storyId} was ignored because its recording is stale.`,
              );
            } else {
              useEditorStore.setState((state) => ({
                tracks: cloneTimelineTracks(parsed.layout.tracks),
                durationMs: parsed.layout.durationMs,
                playheadMs: 0,
                selectedClipId: null,
                selectedPresetId: null,
                selectedTab: "presets",
                _undoExtras: {
                  ...(state._undoExtras ?? {
                    graphSnapshot: {},
                    textOverlays: {},
                    background: DEFAULT_BACKGROUND,
                  }),
                  background: parsed.layout.background,
                },
              }));
              useEditorStore.getState().clearHistory();
              lastSavedTimelineRef.current = serializeCurrentTimelineLayout();
              setTimelineNeedsBootstrap(false);
              setTimelineHydrated(true);
              return;
            }
          } else {
            console.warn(`Saved timeline for story ${storyId} was ignored: ${parsed.reason}`);
          }
        }
      } catch (error) {
        if (timelineLoadTokenRef.current !== token) return;
        console.warn(`Failed to load timeline for story ${storyId}`, error);
      }
      if (timelineLoadTokenRef.current !== token) return;
      setTimelineNeedsBootstrap(true);
      setTimelineHydrated(true);
    })();
  }, [storyId, videoSrc, latestRecording, recordingsQuery.isSuccess, recordingsReady]);

  const actionsQuery = useRecordingActions(latestRecording?.path);
  const recordingActions = actionsQuery.data ?? null;
  const trajectoryQuery = useRecordingTrajectory(
    latestRecording?.path,
    actionsQuery.isSuccess && actionsQuery.data === null,
  );
  const stepTimingQuery = useRecordingStepTiming(latestRecording?.path);
  const resolvedCaptureRect =
    recordingActions?.capture_rect ?? trajectoryQuery.data?.capture_rect ?? null;
  const hasCursorData = Boolean(recordingActions || trajectoryQuery.data);
  const hasStepTimingData = Boolean(stepTimingQuery.data || recordingActions);

  useEffect(() => {
    useEditorStore.setState((state) => ({
      _undoExtras: {
        ...(state._undoExtras ?? {
          graphSnapshot: {},
          textOverlays: {},
          background: { kind: "transparent" },
        }),
        actions: recordingActions,
        stepTiming: stepTimingQuery.data ?? null,
        captureRect: resolvedCaptureRect,
      },
    }));
  }, [recordingActions, resolvedCaptureRect, stepTimingQuery.data]);

  // One-shot auto-populate: only run while generated tracks are empty so we
  // don't clobber persisted user edits. Idempotent on identical inputs.
  const setTracks = useEditorStore((s) => s.setTracks);
  const setDuration = useEditorStore((s) => s.setDuration);
  const tracksVideoLen = useEditorStore((s) => s.tracks.video.length);
  const tracksCursorLen = useEditorStore((s) => s.tracks.cursor.length);
  const tracksZoomLen = useEditorStore((s) => s.tracks.zoom.length);
  const tracksSoundLen = useEditorStore((s) => s.tracks.sound.length);
  const tracksAnnotationLen = useEditorStore((s) => s.tracks.annotations.length);
  const reviewFixItems = useMemo(() => {
    const fixes: ReviewFixItem[] = [];
    const timing = stepTimingQuery.data;
    if (!hasStepTimingData) {
      fixes.push({
        id: "missing-step-timing",
        tone: "warn",
        title: "Step timing missing",
        detail:
          "No steps sidecar was found; polish highlights and callouts are limited to verified action targets.",
      });
    } else if (timing && timing.status !== "completed") {
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
    hasStepTimingData,
    zoomClips,
  ]);
  useEffect(() => {
    if (!latestRecording) return;
    if (!timelineHydrated || !timelineNeedsBootstrap) return;
    if (!timelineBootstrapReady) return;
    if (actionsQuery.isLoading || trajectoryQuery.isLoading || stepTimingQuery.isLoading) return;
    if (tracksVideoLen > 0) return;
    if (tracksCursorLen > 0 || tracksZoomLen > 0 || tracksSoundLen > 0 || tracksAnnotationLen > 0) {
      return;
    }
    const built = buildTimelineFromStory({
      story: storyParsed,
      recording: latestRecording,
      actions: recordingActions,
      trajectory: trajectoryQuery.data ?? null,
      polish: polishDoc,
      stepTiming: stepTimingQuery.data ?? null,
    });
    const { background, warnings, ...generatedTracks } = built;
    const builtTracks = {
      ...generatedTracks,
      annotations: mergeIndependentAnnotations(
        generatedTracks.annotations,
        staleIndependentAnnotationsRef.current,
      ),
    };
    staleIndependentAnnotationsRef.current = [];
    setTracks(builtTracks);
    setDuration(maxTrackEndMs(builtTracks));
    if (warnings.length > 0) {
      const visibleWarnings = warnings.slice(0, 3).map((warning) => warning.message);
      const remainingWarnings = warnings.length - visibleWarnings.length;
      toast.warning(
        `${warnings.length} text overlay${warnings.length === 1 ? "" : "s"} could not be placed`,
        {
          description: `${visibleWarnings.join(" ")}${remainingWarnings > 0 ? ` ${remainingWarnings} more skipped.` : ""} Re-record this story to regenerate step timing.`,
        },
      );
    }
    useEditorStore.setState((state) => ({
      _undoExtras: {
        graphSnapshot: state._undoExtras?.graphSnapshot ?? {},
        textOverlays: state._undoExtras?.textOverlays ?? {},
        background,
      },
    }));
    const layoutJson = serializeCurrentTimelineLayout();
    const saveToken = timelineLoadTokenRef.current;
    void timelineSave(storyId, layoutJson)
      .then(() => {
        if (timelineLoadTokenRef.current !== saveToken) return;
        lastSavedTimelineRef.current = layoutJson;
      })
      .catch((error) => {
        console.warn(`Failed to autosave bootstrapped timeline for story ${storyId}`, error);
      });
    setTimelineNeedsBootstrap(false);
  }, [
    storyId,
    latestRecording,
    polishDoc,
    storyParsed,
    actionsQuery.isLoading,
    recordingActions,
    stepTimingQuery.data,
    stepTimingQuery.isLoading,
    timelineHydrated,
    timelineBootstrapReady,
    timelineNeedsBootstrap,
    trajectoryQuery.data,
    trajectoryQuery.isLoading,
    tracksVideoLen,
    tracksCursorLen,
    tracksZoomLen,
    tracksSoundLen,
    tracksAnnotationLen,
    setTracks,
    setDuration,
  ]);

  useEffect(() => {
    if (!timelineHydrated || timelineNeedsBootstrap) return;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const saveToken = timelineLoadTokenRef.current;
    const unsubscribe = useEditorStore.subscribe((state) => {
      const layoutJson = serializeTimelineLayout({
        tracks: state.tracks,
        durationMs: state.durationMs,
        background: readEditorBackground(state),
      });
      if (layoutJson === lastSavedTimelineRef.current) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        void timelineSave(storyId, layoutJson)
          .then(() => {
            if (timelineLoadTokenRef.current !== saveToken) return;
            lastSavedTimelineRef.current = layoutJson;
          })
          .catch((error) => {
            console.warn(`Failed to autosave timeline for story ${storyId}`, error);
          });
      }, 750);
    });
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
      unsubscribe();
    };
  }, [storyId, timelineHydrated, timelineNeedsBootstrap]);

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
  // first mount. Loaded recordings override it during bootstrap.
  useEffect(() => {
    if (useEditorStore.getState().durationMs === 0) {
      setDuration(60_000);
    }
  }, [setDuration]);

  const effectivePreviewWidthPct =
    workspaceMode === "fine-tune" ? Math.max(previewWidthPct, 74) : Math.max(previewWidthPct, 64);
  const inspectorWidthPct = 100 - effectivePreviewWidthPct;
  const timelinePanelHeightPx = 284;
  const effectiveTopHeight =
    workspaceMode === "review" ? "100%" : `calc(100% - ${timelinePanelHeightPx + 12}px)`;

  const addZoomAtPlayhead = useCallback(() => {
    const playheadMs = useEditorStore.getState().playheadMs;
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
  }, [pushAction, setSelectedClipId, setSelectedTab]);

  const addTextAtPlayhead = useCallback(() => {
    const playheadMs = useEditorStore.getState().playheadMs;
    const defaults = styleDefaults("title");
    const clip: AnnotationClip = {
      id: createClipId("text"),
      trackId: "annotations",
      startMs: playheadMs,
      durationMs: 2_200,
      label: defaults.text,
      ...defaults,
    };
    pushAction({ kind: "add-clip", trackId: "annotations", clip });
    setSelectedClipId(clip.id);
    setSelectedTab("effects");
  }, [pushAction, setSelectedClipId, setSelectedTab]);

  const inspectorContent = !projectOpenReady ? (
    <div role="status" className="p-5 text-sm text-[var(--sc-text-3)]">
      Loading project…
    </div>
  ) : workspaceMode === "review" ? (
    <ReviewPanel
      zoomCount={tracksZoomLen}
      calloutCount={tracksAnnotationLen}
      soundCount={tracksSoundLen}
      videoCount={tracksVideoLen}
      hasTrajectory={hasCursorData}
      hasStepTiming={hasStepTimingData}
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
      <div className="sc-toolbar sc-window-chrome">
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
          <ScBadge tone="muted">Story {storyId}</ScBadge>
        </div>
        <span className="sc-spacer" />
        <ScSegmented
          size="sm"
          value={workspaceMode}
          aria-label="Post-production mode"
          options={[
            { value: "review", label: "Review" },
            { value: "fine-tune", label: "Fine Tune" },
          ]}
          onValueChange={(value) => setWorkspaceMode(value as "review" | "fine-tune")}
        />
        <ScBadge tone={workspaceMode === "review" ? "info" : "accent"}>
          {workspaceMode === "review" ? "Guided Review" : "Timeline Editing"}
        </ScBadge>
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
          <ScBadge tone="muted">0 Queue</ScBadge>
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
        <div className="flex min-h-0 gap-3 px-3 py-3" style={{ height: effectiveTopHeight }}>
          <section
            className="min-w-0 overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] shadow-[var(--sc-sh-1)]"
            style={{
              width: `${effectivePreviewWidthPct}%`,
              display: "flex",
              flexDirection: "column",
            }}
            aria-label="Preview"
          >
            {/* Canvas sub-toolbar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 10px",
                borderBottom: "1px solid var(--sc-border)",
                background: "var(--sc-surface)",
                height: 34,
                flexShrink: 0,
              }}
            >
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--sc-text-4)]">
                Preview
              </span>
              <span style={{ flex: 1 }} />
              <ScButton
                size="sm"
                variant="ghost"
                icon={<ZoomIn size={12} aria-hidden="true" />}
                title="Add zoom keyframe"
                aria-label="Add zoom clip"
                onClick={addZoomAtPlayhead}
              >
                Add Zoom
              </ScButton>
              <ScButton
                size="sm"
                variant="ghost"
                icon={<Type size={12} aria-hidden="true" />}
                title="Add text annotation"
                aria-label="Add text clip"
                onClick={addTextAtPlayhead}
              >
                Add Text
              </ScButton>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
              <PreviewSurface
                mode="post-production"
                storyId={storyId}
                videoSrc={resolvedVideoSrc}
                actions={recordingActions}
                trajectory={trajectoryQuery.data ?? null}
                stepTiming={stepTimingQuery.data ?? null}
                captureRect={resolvedCaptureRect}
              />
              {recordingOverlayMessage && (
                <div
                  className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
                  role="status"
                >
                  <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-2 rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]/92 px-4 py-3 text-center shadow-[var(--sc-sh-1)] backdrop-blur">
                    <div className="text-[12px] font-medium text-[var(--sc-text-2)]">
                      {recordingOverlayMessage}
                    </div>
                    <Link to={`/recorder/${storyId}`} className="sc-btn primary sm">
                      Record one first
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </section>
          <section
            className="min-w-0 overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
            style={{ width: `${inspectorWidthPct}%` }}
          >
            {inspectorContent}
          </section>
        </div>

        {/* Bottom region: timeline */}
        {workspaceMode === "fine-tune" && (
          <section
            className="mx-3 mb-3 flex shrink-0 flex-col overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
            style={{ height: timelinePanelHeightPx }}
            aria-label="Timeline area"
          >
            <div className="flex h-8 items-center gap-2 border-b border-[var(--sc-border)] bg-[var(--sc-surface)] px-3">
              <span className="text-[12px] font-semibold text-[var(--sc-text)]">Timeline</span>
              <span className="font-mono text-[11px] text-[var(--sc-text-4)]">
                {tracksVideoLen}V · {tracksZoomLen}Z · {tracksAnnotationLen}T
                {tracksSoundLen > 0 ? ` · ${tracksSoundLen}A` : ""}
              </span>
              <span className="min-w-0 flex-1" />
              <span className="hidden font-mono text-[11px] text-[var(--sc-text-4)] lg:inline">
                Drag clips to retime. Select a clip to edit.
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <Timeline storyId={storyId} />
            </div>
          </section>
        )}
      </PageContentTransition>

      <SoundDrawer />
      <ExportModal storyId={storyId} />
      <VoiceCatalogDialog projectId={storyId} />
    </div>
  );
}

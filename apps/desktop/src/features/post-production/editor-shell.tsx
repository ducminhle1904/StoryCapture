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
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageContentTransition } from "@/components/page-content-transition";
import { PreviewSurface } from "@/components/preview-surface";
import { VoiceCatalogDialog } from "@/features/voiceover/VoiceCatalogDialog";
import { type ParseResult, parseStory } from "@/ipc/parse";
import { fetchProjectFolder, useProjectRecordings } from "@/ipc/projects";
import { useRecordingTrajectory } from "@/ipc/trajectory";
import { useRecordingActions } from "@/ipc/actions";
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

export function EditorShell({ storyId, videoSrc }: EditorShellProps) {
  const timelineHeightPct = useEditorStore((s) => s.timelineHeightPct);
  const previewWidthPct = useEditorStore((s) => s.previewWidthPct);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const setExportModalOpen = useEditorStore((s) => s.setExportModalOpen);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const pushAction = useEditorStore((s) => s.pushAction);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);

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
  const [projectOpenReady, setProjectOpenReady] = useState(Boolean(videoSrc));
  useEffect(() => {
    let cancelled = false;
    setStoryParsed(null);
    setProjectOpenReady(Boolean(videoSrc));
    (async () => {
      try {
        const info = await fetchProjectFolder(storyId);
        if (cancelled) return;
        setProjectOpenReady(true);
        const text = await readTextFile(info.story_path);
        if (cancelled) return;
        const parsed = await parseStory(text);
        if (cancelled) return;
        setStoryParsed(parsed);
      } catch {
        /* Best-effort. Producer falls back to recording-only timeline. */
        if (!cancelled && videoSrc) {
          setProjectOpenReady(true);
        }
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

  // One-shot auto-populate: only run while generated tracks are empty so we
  // don't clobber persisted user edits. Idempotent on identical inputs.
  const setTracks = useEditorStore((s) => s.setTracks);
  const tracksVideoLen = useEditorStore((s) => s.tracks.video.length);
  const tracksCursorLen = useEditorStore((s) => s.tracks.cursor.length);
  const tracksZoomLen = useEditorStore((s) => s.tracks.zoom.length);
  useEffect(() => {
    if (!latestRecording) return;
    if (tracksVideoLen > 0) return;
    if (tracksCursorLen > 0 || tracksZoomLen > 0) return;
    if (actionsQuery.isLoading) return;
    if (!actionsQuery.data && trajectoryQuery.isLoading) return;
    const built = buildTimelineFromStory({
      story: storyParsed,
      recording: latestRecording,
      actions: actionsQuery.data ?? null,
      trajectory: trajectoryQuery.data ?? null,
    });
    setTracks(built);
  }, [
    latestRecording,
    storyParsed,
    actionsQuery.data,
    actionsQuery.isLoading,
    trajectoryQuery.data,
    trajectoryQuery.isLoading,
    tracksVideoLen,
    tracksCursorLen,
    tracksZoomLen,
    setTracks,
  ]);

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
        <div className="flex min-h-0 gap-5 px-5 py-5" style={{ height: `${topHeightPct}%` }}>
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
            {projectOpenReady ? (
              <InspectorPanel />
            ) : (
              <div role="status" className="p-5 text-sm text-[var(--sc-text-3)]">
                Loading project…
              </div>
            )}
          </section>
        </div>

        {/* Bottom region: timeline */}
        <section
          className="mx-5 mb-5 shrink-0 overflow-hidden rounded-[var(--sc-r-2xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)]"
          style={{ height: `${timelineHeightPct}%` }}
          aria-label="Timeline area"
        >
          <Timeline storyId={storyId} />
        </section>
      </PageContentTransition>

      <SoundDrawer />
      <ExportModal storyId={storyId} />
      <VoiceCatalogDialog projectId={storyId} />
    </div>
  );
}

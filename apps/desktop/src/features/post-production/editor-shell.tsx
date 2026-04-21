/**
 * EditorShell (Plan 02-12b, D-14).
 *
 * 4-pane editor layout:
 *   - Top bar (title + queue widget + export button)
 *   - Preview pane  (top-left, ~60% width)
 *   - Inspector     (top-right, ~25% width)
 *   - Timeline      (bottom, ~30% height)
 *   - Sound drawer  (left slide-out, toggled from Inspector/Sound tab)
 *   - Export modal  (dialog; mounted in DOM always, closed by default)
 *
 * Panes are sized from the persisted Zustand panels slice; splitters are
 * deferred until the resize UX matures (P13 or a dedicated follow-up).
 * The grid rows/cols are computed from the store so user preferences
 * survive reloads.
 */

import { useEffect } from "react";
import {
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
  Volume2,
  ZoomIn,
} from "lucide-react";

import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";
import { PageContentTransition } from "@/components/page-content-transition";
import { useEditorStore } from "./state/store";
import { useEditorHotkeys } from "./hooks/use-hotkeys";
import { Timeline } from "./timeline/timeline";
import { PreviewPlayer } from "./preview/preview-player";
import { InspectorPanel } from "./inspector/inspector-panel";
import { SoundDrawer } from "./sound-browser/sound-drawer";
import { ExportModal } from "./export-modal/export-modal";
import { QueueWidget } from "./render-queue/queue-widget";

export interface EditorShellProps {
  storyId: string;
  videoSrc?: string;
}

export function EditorShell({ storyId, videoSrc }: EditorShellProps) {
  const timelineHeightPct = useEditorStore((s) => s.timelineHeightPct);
  const previewWidthPct = useEditorStore((s) => s.previewWidthPct);
  const setSoundDrawerOpen = useEditorStore((s) => s.setSoundDrawerOpen);
  const setExportModalOpen = useEditorStore((s) => s.setExportModalOpen);

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

  return (
    <div
      className="flex h-full w-full flex-col bg-[var(--sc-bg)] text-[var(--sc-text)]"
      data-editor-shell="true"
      data-story-id={storyId}
    >
      {/* Top bar */}
      <div className="sc-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
        <QueueWidget storyId={storyId} />
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
          style={{ height: `${topHeightPct}%` }}
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
                disabled
                icon={<ZoomIn size={12} aria-hidden="true" />}
                title="Add zoom keyframe — coming soon"
                aria-label="Add zoom keyframe"
              />
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

            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <PreviewPlayer storyId={storyId} videoSrc={videoSrc} />
            </div>

            {/* Shell transport — placeholder; PreviewPlayer owns the real transport. */}
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
            <InspectorPanel />
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
    </div>
  );
}

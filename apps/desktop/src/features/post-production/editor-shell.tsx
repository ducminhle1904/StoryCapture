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
import { Music2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
      className="flex h-full w-full flex-col bg-[var(--color-bg-primary)] text-[var(--color-fg)]"
      data-editor-shell="true"
      data-story-id={storyId}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-300)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
          <span>post-production</span>
          <span className="text-[var(--color-fg-primary)]">story {storyId}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSoundDrawerOpen(true)}
            aria-label="Open sound library"
            className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
          >
            <Music2 className="mr-1 h-4 w-4" />
            Sounds
          </Button>
          <QueueWidget storyId={storyId} />
          <Button
            variant="default"
            size="sm"
            onClick={() => setExportModalOpen(true)}
            aria-label="Open export dialog"
            className="rounded-xl px-4"
          >
            Export
          </Button>
        </div>
      </header>

      <PageContentTransition className="min-h-0 flex-1">
        {/* Top region: preview | inspector */}
        <div
          className="flex min-h-0 gap-5 px-5 py-5"
          style={{ height: `${topHeightPct}%` }}
        >
          <section
            className="min-w-0 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)]"
            style={{ width: `${previewWidthPct}%` }}
            aria-label="Preview"
          >
            <PreviewPlayer storyId={storyId} videoSrc={videoSrc} />
          </section>
          <section
            className="min-w-0 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)]"
            style={{ width: `${inspectorWidthPct}%` }}
          >
            <InspectorPanel />
          </section>
        </div>

        {/* Bottom region: timeline */}
        <section
          className="mx-5 mb-5 shrink-0 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] shadow-[var(--shadow-card)]"
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

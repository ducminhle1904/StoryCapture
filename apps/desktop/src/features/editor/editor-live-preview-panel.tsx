import { ScBadge, ScSegmented } from "@storycapture/ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertTriangle, Monitor, Radio, Smartphone, Tablet } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { PreviewLocationBar } from "@/features/editor/PreviewLocationBar";
import { PickingBanner, PreviewPickerButton } from "@/features/editor/PreviewPickerButton";
import type { PreviewLifecycleStatus, PreviewNavState } from "@/features/editor/preview-lifecycle";
import { SimulatorFrameView } from "@/features/editor/preview-panel";
import { LivePreview } from "@/features/recorder/live-preview";
import type { RecordingInfo } from "@/ipc/projects";
import { type PreviewViewport, VIEWPORT_SIZES } from "@/state/editor";

type SimulatorFrame = ComponentProps<typeof SimulatorFrameView>["frame"];

const VIEWPORT_LABELS: Record<PreviewViewport, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
};

interface EditorLivePreviewPanelProps {
  appUrl: string | null | undefined;
  appUrlValid: boolean;
  authorDriverVariant: string;
  latestRecording: RecordingInfo | null;
  previewNav: PreviewNavState;
  previewStatus: PreviewLifecycleStatus;
  previewViewport: PreviewViewport;
  polishIntentCount: number;
  simulatorActiveFrame: SimulatorFrame | null;
  simulatorRunState: string;
  streamId: string | null;
  onViewportChange: (viewport: PreviewViewport) => void;
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

function statusTone({
  appUrlValid,
  previewStatus,
  streamId,
  simulatorActiveFrame,
}: {
  appUrlValid: boolean;
  previewStatus: PreviewLifecycleStatus;
  streamId: string | null;
  simulatorActiveFrame: SimulatorFrame | null;
}): ComponentProps<typeof ScBadge>["tone"] {
  if (simulatorActiveFrame) return "info";
  if (!appUrlValid) return "muted";
  if (previewStatus === "error") return "record";
  if (streamId) return "success";
  return "warn";
}

function statusLabel({
  appUrlValid,
  previewStatus,
  streamId,
  simulatorActiveFrame,
}: {
  appUrlValid: boolean;
  previewStatus: PreviewLifecycleStatus;
  streamId: string | null;
  simulatorActiveFrame: SimulatorFrame | null;
}): string {
  if (simulatorActiveFrame) return "simulator";
  if (!appUrlValid) return "no app";
  if (previewStatus === "error") return "failed";
  if (streamId) return "live";
  return "starting";
}

function computeStageFit({
  viewport,
  availableWidth,
  availableHeight,
}: {
  viewport: PreviewViewport;
  availableWidth: number;
  availableHeight: number;
}): { width: number; height: number; scale: number } | null {
  const size = VIEWPORT_SIZES[viewport];
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  const scale = Math.min(availableWidth / size.w, availableHeight / size.h);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    width: Math.max(1, Math.floor(size.w * scale)),
    height: Math.max(1, Math.floor(size.h * scale)),
    scale,
  };
}

function useStageFit(containerRef: RefObject<HTMLDivElement | null>, viewport: PreviewViewport) {
  const [fit, setFit] = useState<{ width: number; height: number; scale: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      setFit(
        computeStageFit({
          viewport,
          availableWidth: rect.width,
          availableHeight: rect.height,
        }),
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, viewport]);

  return fit;
}

function StageShell({
  viewport,
  fit,
  children,
}: {
  viewport: PreviewViewport;
  fit: { width: number; height: number; scale: number } | null;
  children: ReactNode;
}) {
  const size = VIEWPORT_SIZES[viewport];
  return (
    <section
      className="relative overflow-hidden rounded-[var(--sc-r-lg)] border border-[var(--sc-border-2)] bg-[var(--sc-n-950)] shadow-[var(--sc-sh-3)]"
      style={{
        aspectRatio: `${size.w} / ${size.h}`,
        width: fit ? `${fit.width}px` : "100%",
        height: fit ? `${fit.height}px` : undefined,
        maxWidth: "100%",
        maxHeight: "100%",
      }}
      aria-label={`Preview viewport: ${VIEWPORT_LABELS[viewport]} (${size.w}x${size.h})`}
    >
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1.5 text-[9px] uppercase tracking-[0.12em]">
        <span className="rounded-[var(--sc-r-xs)] border border-white/10 bg-[var(--sc-n-950)]/70 px-1.5 py-0.5 text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
          {VIEWPORT_LABELS[viewport]}
        </span>
        <span className="rounded-[var(--sc-r-xs)] border border-white/10 bg-[var(--sc-n-950)]/70 px-1.5 py-0.5 font-mono text-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
          {size.w} x {size.h}
        </span>
        {fit ? (
          <span className="rounded-[var(--sc-r-xs)] border border-white/10 bg-[var(--sc-n-950)]/70 px-1.5 py-0.5 font-mono text-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
            {Math.round(fit.scale * 100)}%
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StartingPreview({ appUrl }: { appUrl: string | null | undefined }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center">
      <div className="h-20 w-40 overflow-hidden rounded-[var(--sc-r-sm)] border border-white/10 bg-white/5">
        <div className="h-full w-full animate-pulse bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.08)_42%,transparent_74%)]" />
      </div>
      <div className="space-y-1">
        <div className="font-mono text-[12px] text-[var(--sc-text-2)]">Starting preview</div>
        <div className="max-w-[28ch] truncate text-[10px] text-[var(--sc-text-4)]">
          {appUrl ?? ""}
        </div>
      </div>
    </div>
  );
}

function PreviewErrorState({ appUrl }: { appUrl: string | null | undefined }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-[var(--sc-r-md)] border border-[var(--sc-record)]/30 bg-[var(--sc-record)]/10">
        <AlertTriangle size={18} aria-hidden="true" className="text-[var(--sc-record)]" />
      </div>
      <div className="space-y-1">
        <div className="text-[13px] font-medium text-[var(--sc-text-2)]">Preview did not start</div>
        <div className="max-w-[30ch] text-[11px] leading-4 text-[var(--sc-text-4)]">
          Check the app URL or sidecar logs, then reload the preview.
        </div>
        {appUrl ? (
          <div className="truncate font-mono text-[10px] text-[var(--sc-text-4)]">{appUrl}</div>
        ) : null}
      </div>
    </div>
  );
}

function NoAppState({ latestRecording }: { latestRecording: RecordingInfo | null }) {
  if (latestRecording) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--sc-n-950)] p-3">
        {/* biome-ignore lint/a11y/useMediaCaption: user-captured screen recording; no caption track exists in source */}
        <video
          src={convertFileSrc(latestRecording.path)}
          controls
          preload="metadata"
          className="h-full w-full rounded-[var(--sc-r-sm)] border border-white/10 bg-[var(--sc-n-950)] object-contain"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center">
      <Radio size={28} aria-hidden="true" className="text-[var(--sc-text-4)]" />
      <div className="space-y-1">
        <div className="font-mono text-[12px] text-[var(--sc-text-2)]">No app URL</div>
        <div className="max-w-[30ch] text-[11px] leading-4 text-[var(--sc-text-4)]">
          Set <code>meta.app</code> in the story to launch Live Preview.
        </div>
      </div>
    </div>
  );
}

export function EditorLivePreviewPanel({
  appUrl,
  appUrlValid,
  authorDriverVariant,
  latestRecording,
  previewNav,
  previewStatus,
  previewViewport,
  polishIntentCount,
  simulatorActiveFrame,
  simulatorRunState,
  streamId,
  onViewportChange,
}: EditorLivePreviewPanelProps) {
  const size = VIEWPORT_SIZES[previewViewport];
  const stageAreaRef = useRef<HTMLDivElement | null>(null);
  const stageFit = useStageFit(stageAreaRef, previewViewport);
  const badgeTone = statusTone({
    appUrlValid,
    previewStatus,
    streamId,
    simulatorActiveFrame,
  });
  const badgeLabel = statusLabel({
    appUrlValid,
    previewStatus,
    streamId,
    simulatorActiveFrame,
  });

  return (
    <div className="flex h-full flex-col bg-[var(--sc-surface)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome-2)] px-3">
        <span className="text-[12px] font-semibold text-[var(--sc-text)]">Live Preview</span>
        <ScBadge tone={badgeTone} dot>
          {badgeLabel}
        </ScBadge>
        {polishIntentCount > 0 ? (
          <ScBadge tone="info">{polishIntentCount} polish cues</ScBadge>
        ) : null}
        <PreviewPickerButton />
        <span className="min-w-0 flex-1" />
        <ScSegmented
          size="sm"
          value={previewViewport}
          onValueChange={(v) => onViewportChange(v as PreviewViewport)}
          aria-label="Viewport size"
          options={[
            {
              value: "mobile",
              label: <Smartphone size={12} aria-label="Mobile" />,
            },
            {
              value: "tablet",
              label: <Tablet size={12} aria-label="Tablet" />,
            },
            {
              value: "desktop",
              label: <Monitor size={12} aria-label="Desktop" />,
            },
          ]}
        />
      </div>

      <PreviewLocationBar
        streamId={streamId}
        url={previewNav.url}
        canGoBack={previewNav.canGoBack}
        canGoForward={previewNav.canGoForward}
        disabled={
          !appUrlValid ||
          simulatorRunState === "running" ||
          authorDriverVariant === "picking" ||
          previewStatus === "error"
        }
      />

      {authorDriverVariant === "picking" ? <PickingBanner variant="active" /> : null}

      <div
        ref={stageAreaRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--sc-surface-2)] p-3"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(var(--sc-border) 1px, transparent 1px), linear-gradient(90deg, var(--sc-border) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <StageShell viewport={previewViewport} fit={stageFit}>
          {simulatorActiveFrame ? (
            <SimulatorFrameView frame={simulatorActiveFrame} />
          ) : streamId ? (
            <LivePreview
              streamId={streamId}
              width={size.w}
              height={size.h}
              pageWidth={size.w}
              pageHeight={size.h}
              pickerArmed={authorDriverVariant === "picking"}
              className="h-full w-full rounded-none border-0 bg-[var(--sc-n-950)]"
            />
          ) : previewStatus === "error" ? (
            <PreviewErrorState appUrl={appUrl} />
          ) : appUrlValid ? (
            <StartingPreview appUrl={appUrl} />
          ) : (
            <NoAppState latestRecording={latestRecording} />
          )}
        </StageShell>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-3 font-mono text-[11px] text-[var(--sc-text-3)]">
        <ScBadge tone="muted" dot>
          {latestRecording ? `Latest: ${formatRelative(latestRecording.captured_at)}` : "Idle"}
        </ScBadge>
        <span>
          {latestRecording?.width && latestRecording.height
            ? `${latestRecording.width} x ${latestRecording.height}`
            : `${size.w} x ${size.h}`}
        </span>
        {stageFit ? <span>{Math.round(stageFit.scale * 100)}%</span> : null}
        <span className="min-w-0 flex-1" />
      </div>
    </div>
  );
}

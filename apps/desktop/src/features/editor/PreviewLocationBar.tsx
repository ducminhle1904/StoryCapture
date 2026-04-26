import { ScButton, cn } from "@storycapture/ui";
import { ArrowLeft, ArrowRight, Globe, RotateCcw } from "lucide-react";

import {
  authorPreviewBack,
  authorPreviewForward,
  authorPreviewReload,
} from "@/ipc/preview";
import { frontendLog } from "@/lib/log";

export interface PreviewLocationBarProps {
  streamId: string | null;
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Disable nav buttons (simulator running, picking, paused, no app URL). */
  disabled: boolean;
}

function logFailure(action: "back" | "forward" | "reload") {
  return (err: unknown) => {
    frontendLog.warn("previewLocationBar", `${action} failed`, { error: err });
  };
}

export function PreviewLocationBar({
  streamId,
  url,
  canGoBack,
  canGoForward,
  disabled,
}: PreviewLocationBarProps) {
  const navDisabled = disabled || streamId == null;
  return (
    <div
      data-testid="preview-location-bar"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome-2)] px-2"
    >
      <ScButton
        size="icon"
        variant="ghost"
        icon={<ArrowLeft size={14} />}
        aria-label="Back"
        title="Back"
        disabled={navDisabled || !canGoBack}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewBack(streamId).catch(logFailure("back"));
        }}
      />
      <ScButton
        size="icon"
        variant="ghost"
        icon={<ArrowRight size={14} />}
        aria-label="Forward"
        title="Forward"
        disabled={navDisabled || !canGoForward}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewForward(streamId).catch(logFailure("forward"));
        }}
      />
      <ScButton
        size="icon"
        variant="ghost"
        icon={<RotateCcw size={14} />}
        aria-label="Reload"
        title="Reload"
        disabled={navDisabled}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewReload(streamId).catch(logFailure("reload"));
        }}
      />
      <div
        data-testid="preview-url-display"
        role="textbox"
        aria-readonly="true"
        aria-label="Current preview URL"
        title={url ?? ""}
        className={cn(
          "flex h-6 flex-1 items-center gap-1.5 truncate rounded-[var(--radius-sm)]",
          "border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-2",
          "font-mono text-[11px] text-[var(--sc-text-2)]",
          "cursor-text select-text",
        )}
      >
        <Globe size={12} aria-hidden="true" className="shrink-0 opacity-60" />
        {url ? (
          <span className="truncate">{url}</span>
        ) : (
          <span className="truncate text-[var(--sc-text-4)]">—</span>
        )}
      </div>
    </div>
  );
}

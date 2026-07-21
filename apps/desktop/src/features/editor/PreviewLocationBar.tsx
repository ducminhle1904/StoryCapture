import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { ArrowLeft, ArrowRight, Globe, RotateCcw } from "lucide-react";
import { authorPreviewBack, authorPreviewForward, authorPreviewReload } from "@/ipc/preview";
import { frontendLog } from "@/lib/log";
import { cn } from "@/lib/utils";

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
      className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] px-2"
    >
      <AstryxButton
        size="sm"
        isIconOnly
        variant="ghost"
        icon={<ArrowLeft size={14} />}
        aria-label="Back"
        tooltip="Back"
        isDisabled={navDisabled || !canGoBack}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewBack(streamId).catch(logFailure("back"));
        }}
        label="Back"
      />
      <AstryxButton
        size="sm"
        isIconOnly
        variant="ghost"
        icon={<ArrowRight size={14} />}
        aria-label="Forward"
        tooltip="Forward"
        isDisabled={navDisabled || !canGoForward}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewForward(streamId).catch(logFailure("forward"));
        }}
        label="Forward"
      />
      <AstryxButton
        size="sm"
        isIconOnly
        variant="ghost"
        icon={<RotateCcw size={14} />}
        aria-label="Reload"
        tooltip="Reload"
        isDisabled={navDisabled}
        onClick={() => {
          if (streamId == null) return;
          authorPreviewReload(streamId).catch(logFailure("reload"));
        }}
        label="Reload"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: This is a selectable, read-only URL display rather than an editable field. */}
      <div
        data-testid="preview-url-display"
        role="textbox"
        aria-readonly="true"
        aria-label="Current preview URL"
        tabIndex={0}
        title={url ?? ""}
        className={cn(
          "flex h-6 flex-1 items-center gap-1.5 truncate rounded-[var(--radius-inner)]",
          "border border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] px-2",
          "font-mono text-[11px] text-[var(--color-text-secondary)]",
          "cursor-text select-text",
        )}
      >
        <Globe size={12} aria-hidden="true" className="shrink-0 opacity-60" />
        {url ? (
          <span className="truncate">{url}</span>
        ) : (
          <span className="truncate text-[var(--color-text-disabled)]">—</span>
        )}
      </div>
    </div>
  );
}

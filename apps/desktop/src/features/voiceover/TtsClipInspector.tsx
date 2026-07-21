/**
 * TTS clip inspector.
 *
 * Shows the current take in a minimal summary row.
 *
 * States: generated, out-of-sync-with-script, regenerating, failed, selected.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { TtsClip } from "./voiceoverStore";

export type TtsClipStatus =
  | "generated"
  | "out-of-sync-with-script"
  | "regenerating"
  | "failed"
  | "selected";

export interface TtsClipInspectorProps {
  stepId: string;
  projectId: string;
  clip: TtsClip;
  presetName: string;
  status: TtsClipStatus;
  stepLabel?: string;
  cacheHit?: boolean;
  onRegenerate: () => void;
}

const STATUS_COLORS: Record<TtsClipStatus, string> = {
  generated: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  "out-of-sync-with-script": "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  regenerating: "bg-[var(--color-text-blue)]/15 text-[var(--color-text-blue)]",
  failed: "bg-[var(--color-error)]/15 text-[var(--color-error)]",
  selected: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
};

const STATUS_LABELS: Record<TtsClipStatus, string> = {
  generated: "Generated",
  "out-of-sync-with-script": "Out of sync",
  regenerating: "Regenerating",
  failed: "Failed",
  selected: "Selected",
};

function formatDuration(ms: number): string {
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

export function TtsClipInspector({
  stepId,
  projectId: _projectId,
  clip,
  presetName,
  status,
  stepLabel,
  cacheHit,
  onRegenerate,
}: TtsClipInspectorProps) {
  return (
    <div
      data-testid="tts-clip-inspector"
      className="flex items-center justify-between gap-4 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-4 py-3"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
            {stepLabel ?? stepId}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <span>{presetName}</span>
          <span className="text-[var(--color-border)]">/</span>
          <span
            className="font-mono"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}
          >
            {formatDuration(clip.durationMs)}
          </span>
          {cacheHit !== undefined ? (
            <>
              <span className="text-[var(--color-border)]">/</span>
              <span>{cacheHit ? "Cached" : "Fresh render"}</span>
            </>
          ) : null}
        </div>
      </div>

      <AstryxButton
        variant="secondary"
        size="sm"
        onClick={onRegenerate}
        isDisabled={status === "regenerating"}
        label="Regenerate voiceover"
      >
        {status === "regenerating" ? "Regenerating..." : "Regenerate"}
      </AstryxButton>
    </div>
  );
}

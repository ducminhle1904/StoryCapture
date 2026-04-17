/**
 * TTS clip inspector.
 *
 * Shows the current take in a minimal summary row.
 *
 * States: generated, out-of-sync-with-script, regenerating, failed, selected.
 */

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
  generated: "bg-[var(--success)]/15 text-[var(--success)]",
  "out-of-sync-with-script": "bg-[var(--warning)]/15 text-[var(--warning)]",
  regenerating: "bg-[var(--info)]/15 text-[var(--info)]",
  failed: "bg-[var(--destructive)]/15 text-[var(--destructive)]",
  selected: "bg-[var(--accent)]/15 text-[var(--accent)]",
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
      className="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--card)] px-4 py-3"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--foreground)]">
            {stepLabel ?? stepId}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
          <span>{presetName}</span>
          <span className="text-[var(--border)]">/</span>
          <span
            className="font-mono"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}
          >
            {formatDuration(clip.durationMs)}
          </span>
          {cacheHit !== undefined ? (
            <>
              <span className="text-[var(--border)]">/</span>
              <span>{cacheHit ? "Cached" : "Fresh render"}</span>
            </>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--foreground)]/5 disabled:opacity-50"
        onClick={onRegenerate}
        disabled={status === "regenerating"}
      >
        {status === "regenerating" ? "Regenerating..." : "Regenerate"}
      </button>
    </div>
  );
}

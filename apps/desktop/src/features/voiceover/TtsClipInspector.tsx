/**
 * TTS clip inspector.
 *
 * Shows clip duration, voice preset name, cost, cache-hit indicator,
 * and regenerate button. Displays timeline-clip states from UI-SPEC.
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
  generated: "\u0110\u00e3 t\u1ea1o",
  "out-of-sync-with-script":
    "Kh\u00f4ng \u0111\u1ed3ng b\u1ed9",
  regenerating: "\u0110ang t\u1ea1o l\u1ea1i",
  failed: "L\u1ed7i",
  selected: "\u0110\u00e3 ch\u1ECDn",
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
  cacheHit,
  onRegenerate,
}: TtsClipInspectorProps) {
  return (
    <div
      data-testid="tts-clip-inspector"
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--foreground)]">
          {`B\u01b0\u1edbc ${stepId}`}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      {/* Clip info */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
          <span>{`Gi\u1ECDng: ${presetName}`}</span>
          <span
            className="font-mono"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}
          >
            {formatDuration(clip.durationMs)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
          <span>${clip.costUsd.toFixed(4)}</span>
          {cacheHit !== undefined && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                cacheHit
                  ? "bg-[var(--success)]/10 text-[var(--success)]"
                  : "bg-[var(--muted-foreground)]/10 text-[var(--muted-foreground)]"
              }`}
            >
              {cacheHit ? "Cache hit" : "Cache miss"}
            </span>
          )}
        </div>
      </div>

      {/* Regenerate button */}
      <button
        type="button"
        className="mt-1 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:opacity-50"
        onClick={onRegenerate}
        disabled={status === "regenerating"}
      >
        {status === "regenerating"
          ? `\u0110ang t\u1ea1o l\u1ea1i...`
          : `T\u1ea1o l\u1ea1i audio`}
      </button>
    </div>
  );
}

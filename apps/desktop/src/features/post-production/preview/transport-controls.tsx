/**
 * Transport controls — minimal play/pause + jump buttons. The real
 * play-tick loop lives in `preview-player.tsx`; these buttons dispatch
 * the same custom event the space hotkey uses so there is one source
 * of truth for toggling.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { memo } from "react";
import { useEditorStore } from "../state/store";

export interface TransportControlsProps {
  playing: boolean;
  onTogglePlay: () => void;
}

function TransportControlsBase({ playing, onTogglePlay }: TransportControlsProps) {
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const durationMs = useEditorStore((s) => s.durationMs);
  const maxPlayheadMs = Math.max(0, durationMs);
  const canJumpBack = playheadMs > 0;
  const canJumpForward = maxPlayheadMs === 0 || playheadMs < maxPlayheadMs;

  return (
    <div role="toolbar" aria-label="Preview transport" className="flex items-center gap-1.5">
      <AstryxButton
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label="Jump back 5 seconds"
        isDisabled={!canJumpBack}
        onClick={() => setPlayhead(Math.max(0, playheadMs - 5000))}
        className="h-8 w-8 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-card)] active:scale-[0.98] disabled:cursor-default disabled:opacity-45"
        label="Jump back 5 seconds"
      >
        <SkipBack className="h-4 w-4" />
      </AstryxButton>
      <AstryxButton
        variant="primary"
        size="sm"
        isIconOnly
        aria-label={playing ? "Pause" : "Play"}
        onClick={onTogglePlay}
        className="h-8 w-8 rounded-[var(--radius-container)] bg-[var(--color-text-primary)] text-[var(--color-background-body)] hover:bg-[var(--color-text-secondary)] active:scale-[0.98]"
        label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </AstryxButton>
      <AstryxButton
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label="Jump forward 5 seconds"
        isDisabled={!canJumpForward}
        onClick={() =>
          setPlayhead(
            maxPlayheadMs > 0 ? Math.min(maxPlayheadMs, playheadMs + 5000) : playheadMs + 5000,
          )
        }
        className="h-8 w-8 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-card)] active:scale-[0.98] disabled:cursor-default disabled:opacity-45"
        label="Jump forward 5 seconds"
      >
        <SkipForward className="h-4 w-4" />
      </AstryxButton>
      <span className="ml-1 min-w-[56px] rounded-full border border-[var(--color-border)] bg-[var(--color-background-card)] px-2.5 py-1 text-center text-xs tabular-nums text-[var(--color-text-secondary)]">
        {(playheadMs / 1000).toFixed(2)}s
      </span>
    </div>
  );
}

export const TransportControls = memo(TransportControlsBase);

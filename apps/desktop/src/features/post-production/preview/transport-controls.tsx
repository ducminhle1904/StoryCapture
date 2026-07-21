/**
 * Transport controls — minimal play/pause + jump buttons. The real
 * play-tick loop lives in `preview-player.tsx`; these buttons dispatch
 * the same custom event the space hotkey uses so there is one source
 * of truth for toggling.
 */

import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { memo } from "react";

import { ScButton as Button } from "@storycapture/ui";
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
      <Button
        variant="ghost"
        size="icon"
        aria-label="Jump back 5 seconds"
        disabled={!canJumpBack}
        onClick={() => setPlayhead(Math.max(0, playheadMs - 5000))}
        className="h-8 w-8 rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] text-[var(--sc-text-2)] hover:bg-[var(--sc-surface-2)] active:scale-[0.98] disabled:cursor-default disabled:opacity-45"
        icon={<SkipBack className="h-4 w-4" />}
      />
      <Button
        variant="default"
        size="icon"
        aria-label={playing ? "Pause" : "Play"}
        onClick={onTogglePlay}
        className="h-8 w-8 rounded-[var(--sc-r-lg)] bg-[var(--sc-text)] text-[var(--sc-bg)] hover:bg-[var(--sc-text-2)] active:scale-[0.98]"
        icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Jump forward 5 seconds"
        disabled={!canJumpForward}
        onClick={() =>
          setPlayhead(
            maxPlayheadMs > 0 ? Math.min(maxPlayheadMs, playheadMs + 5000) : playheadMs + 5000,
          )
        }
        className="h-8 w-8 rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] text-[var(--sc-text-2)] hover:bg-[var(--sc-surface-2)] active:scale-[0.98] disabled:cursor-default disabled:opacity-45"
        icon={<SkipForward className="h-4 w-4" />}
      />
      <span className="ml-1 min-w-[56px] rounded-full border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2.5 py-1 text-center text-xs tabular-nums text-[var(--sc-text-3)]">
        {(playheadMs / 1000).toFixed(2)}s
      </span>
    </div>
  );
}

export const TransportControls = memo(TransportControlsBase);

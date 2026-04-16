/**
 * Transport controls (Plan 02-12b).
 *
 * Minimal play/pause + jump buttons. The real play-tick loop lives in
 * `preview-player.tsx`; these buttons dispatch the same custom event
 * the space hotkey uses so there is one source of truth for toggling.
 */

import { memo } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEditorStore } from "../state/store";

export interface TransportControlsProps {
  playing: boolean;
  onTogglePlay: () => void;
}

function TransportControlsBase({ playing, onTogglePlay }: TransportControlsProps) {
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const playheadMs = useEditorStore((s) => s.playheadMs);

  return (
    <div
      role="toolbar"
      aria-label="Preview transport"
      className="flex items-center gap-2"
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Jump back 5 seconds"
        onClick={() => setPlayhead(Math.max(0, playheadMs - 5000))}
        className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/8"
      >
        <SkipBack className="h-4 w-4" />
      </Button>
      <Button
        variant="default"
        size="icon"
        aria-label={playing ? "Pause" : "Play"}
        onClick={onTogglePlay}
        className="rounded-2xl"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Jump forward 5 seconds"
        onClick={() => setPlayhead(playheadMs + 5000)}
        className="rounded-xl border border-white/8 bg-white/4 hover:bg-white/8"
      >
        <SkipForward className="h-4 w-4" />
      </Button>
      <span className="ml-2 rounded-full border border-white/8 bg-white/4 px-3 py-1 text-xs tabular-nums text-[var(--color-fg-muted)]">
        {(playheadMs / 1000).toFixed(2)}s
      </span>
    </div>
  );
}

export const TransportControls = memo(TransportControlsBase);

/**
 * SoundRow — single entry in the sound library drawer. Renders a
 * wavesurfer.js static waveform, the name, and the license. Draggable:
 * dragging onto the Sound track in the timeline adds a clip via
 * `addSoundClip`.
 *
 * Only drags originating from *this* component carry the `sound-entry`
 * dataTransfer type, so timeline drop targets can reject external file
 * drops.
 */

import { memo, useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import WaveSurfer from "wavesurfer.js";

import type { SoundLibraryEntry } from "@/ipc/sound-library";

export interface SoundRowProps {
  entry: SoundLibraryEntry;
}

function SoundRowBase({ entry }: SoundRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let ws: WaveSurfer | null = null;
    try {
      ws = WaveSurfer.create({
        container: containerRef.current,
        waveColor: "#4a8eff",
        progressColor: "#4a8eff",
        height: 32,
        barWidth: 2,
        interact: false,
        cursorWidth: 0,
      });
      const src = entry.file_path.startsWith("asset:")
        ? entry.file_path
        : convertFileSrc(entry.file_path);
      void ws.load(src);
    } catch (err) {
      // happy-dom / tests: wavesurfer may throw on missing AudioContext.
      // eslint-disable-next-line no-console
      console.debug("[post-production] wavesurfer init skipped", err);
    }
    return () => {
      try {
        ws?.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [entry.file_path]);

  return (
    <div
      role="listitem"
      aria-label={`${entry.name}, ${Math.round(entry.duration_ms)} ms, ${entry.license}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("sound-entry", JSON.stringify(entry));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="flex cursor-grab items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm hover:border-[var(--color-accent,#ff5b76)]"
    >
      <div ref={containerRef} className="h-8 flex-1" />
      <div className="flex w-40 flex-col text-right">
        <span className="truncate text-[var(--color-fg)]">{entry.name}</span>
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-fg-muted)]">
          {entry.license} • {(entry.duration_ms / 1000).toFixed(1)}s
        </span>
      </div>
    </div>
  );
}

export const SoundRow = memo(SoundRowBase);

/**
 * Time ruler — renders tick marks + labels every second across the
 * timeline width. Stateless; consumers pass `durationMs` + `pxPerMs`.
 */

import { memo } from "react";

export interface TimeRulerProps {
  durationMs: number;
  pxPerMs: number;
  height?: number;
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function TimeRulerBase({ durationMs, pxPerMs, height = 24 }: TimeRulerProps) {
  const totalSec = Math.max(1, Math.ceil(durationMs / 1000));
  const width = Math.max(0, durationMs * pxPerMs);
  const ticks = Array.from({ length: totalSec + 1 }, (_, i) => i);

  return (
    <div
      className="relative select-none border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] text-[10px] text-[var(--color-fg-muted)]"
      style={{ width, height }}
      role="presentation"
    >
      {ticks.map((sec) => {
        const left = sec * 1000 * pxPerMs;
        return (
          <div
            key={sec}
            className="absolute top-0 h-full"
            style={{ left }}
          >
            <div className="h-2 w-px bg-[var(--color-surface-300)]" />
            <div className="pl-1">{formatMs(sec * 1000)}</div>
          </div>
        );
      })}
    </div>
  );
}

export const TimeRuler = memo(TimeRulerBase);

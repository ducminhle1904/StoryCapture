import { useMemo } from "react";

import { getCursorPositions, useRecorderStore } from "@/state/recorder";

/**
 * Live cursor trail visualization. Reads `cursorPositions` from the
 * recorder store; each point has a timestamp and segments older than 2s
 * fade to zero opacity. Fixed-position SVG overlay above the HUD that
 * doesn't intercept pointer events.
 */
export function CursorTrail() {
  const ring = useRecorderStore((s) => s.cursorPositions);
  const points = useMemo(() => getCursorPositions(ring), [ring]);

  const polylinePoints = useMemo(() => points.map((p) => `${p.x},${p.y}`).join(" "), [points]);

  if (points.length < 2) return null;

  return (
    <svg
      role="img"
      aria-label="Live cursor position overlay"
      className="pointer-events-none fixed inset-0 z-20 h-full w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <polyline
        points={polylinePoints}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.75}
      />
      {points.length > 0 && (
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r={6}
          fill="var(--color-accent)"
          opacity={0.9}
        />
      )}
    </svg>
  );
}

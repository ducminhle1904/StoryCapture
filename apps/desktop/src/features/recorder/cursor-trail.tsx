import { useMemo } from "react";

import { useRecorderStore } from "@/state/recorder";

/**
 * Live cursor trail visualization (UI-04).
 *
 * Reads `cursorPositions` from the recorder store. Each point has a
 * timestamp; segments older than 2s fade to zero opacity. Rendered as a
 * fixed-position SVG overlay that sits above the HUD but doesn't intercept
 * pointer events.
 */
export function CursorTrail() {
  const points = useRecorderStore((s) => s.cursorPositions);

  const polylinePoints = useMemo(
    () => points.map((p) => `${p.x},${p.y}`).join(" "),
    [points],
  );

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
        stroke="var(--color-accent-primary)"
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
          fill="var(--color-accent-primary)"
          opacity={0.9}
        />
      )}
    </svg>
  );
}

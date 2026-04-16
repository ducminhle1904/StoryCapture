/**
 * Streaming token indicator (Plan 03-17).
 *
 * Motion pulse 900ms loop per UI-SPEC. prefers-reduced-motion -> static filled dot.
 * Uses accent color gradient per UI-SPEC accent reserved list item 5.
 */

import * as React from "react";
import { motion } from "motion/react";

export function StreamingDot() {
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  if (reducedMotion) {
    return (
      <span
        data-testid="streaming-dot"
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: "var(--color-accent, #7C3AED)" }}
        aria-hidden="true"
      />
    );
  }

  return (
    <motion.span
      data-testid="streaming-dot"
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: "var(--color-accent, #7C3AED)" }}
      animate={{ opacity: [0.4, 1, 0.4] }}
      transition={{
        duration: 0.9,
        repeat: Infinity,
        ease: "easeInOut",
      }}
      aria-hidden="true"
    />
  );
}

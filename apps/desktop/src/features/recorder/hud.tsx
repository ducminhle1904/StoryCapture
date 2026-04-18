import { motion } from "motion/react";

import { useRecorderStore } from "@/state/recorder";

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Recording HUD (UI-04): pulsing red dot + timer + project name. Mounted as
 * a fixed overlay while the recorder is actively capturing.
 */
export function RecordingHud({ projectName }: { projectName: string }) {
  const status = useRecorderStore((s) => s.status);
  const elapsedMs = useRecorderStore((s) => s.elapsedMs);
  const active = status === "recording" || status === "paused";

  if (!active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${status === "paused" ? "Paused" : "Recording"} ${projectName}, elapsed ${formatTime(elapsedMs)}`}
      className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 z-30 flex items-center gap-3 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]/90 px-4 py-2 shadow-xl backdrop-blur"
    >
      <motion.span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full ${status === "paused" ? "bg-[var(--color-warning)]" : "bg-[var(--color-danger)]"}`}
        animate={status === "recording" ? { scale: [1, 1.15, 1], opacity: [1, 0.7, 1] } : undefined}
        transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
      />
      <span className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
        {status === "paused" ? "Paused" : "Rec"}
      </span>
      <span className="font-mono text-sm tabular-nums text-[var(--color-fg-primary)]">
        {formatTime(elapsedMs)}
      </span>
      <span className="text-xs text-[var(--color-fg-muted)] max-w-[160px] truncate">
        {projectName}
      </span>
    </div>
  );
}

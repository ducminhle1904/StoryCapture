import { AnimatePresence, motion } from "motion/react";
import { useAppSettingsStore } from "@/state/app-settings";
import { useRecorderStore } from "@/state/recorder";

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function RecordingIndicator() {
  const status = useRecorderStore((s) => s.status);
  const elapsedMs = useRecorderStore((s) => s.elapsedMs);
  const showProgressBadge = useAppSettingsStore(
    (s) => s.settings?.general.dock_progress_badge ?? true,
  );
  const active = showProgressBadge && (status === "recording" || status === "paused");

  return (
    <AnimatePresence>
      {active ? (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18 }}
          className="story-recording-indicator fixed z-[80] inline-flex items-center gap-3 px-3.5 py-1.5"
          style={{
            top: 58,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--color-background-body, var(--color-background-surface))",
            border: "1px solid oklch(0.65 0.20 22 / 0.4)",
            borderRadius: 999,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06)",
            color: "var(--color-text-primary)",
            fontSize: 12.5,
            fontWeight: 500,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: 99,
              background: "var(--story-recording, #ef4444)",
              animation: "story-recording-pulse 1.2s ease-in-out infinite",
            }}
          />
          <span
            style={{
              fontVariantNumeric: "tabular-nums",
              fontFamily: "var(--font-family-code, ui-monospace, monospace)",
            }}
          >
            REC · {formatClock(elapsedMs)}
          </span>
          {status === "paused" ? (
            <span style={{ color: "var(--color-text-disabled)", fontSize: 11.5 }}>· paused</span>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

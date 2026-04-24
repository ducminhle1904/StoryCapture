import { motion } from "motion/react";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";

import { useRecorderStore } from "@/state/recorder";

import { RECORD_PATH_MISS_BODY } from "./primary-miss-copy";

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Recording HUD (UI-04): pulsing red dot + timer + project name. Mounted as
 * a fixed overlay while the recorder is actively capturing.
 *
 * Phase 11-02 (D-06): when the recorder store carries a `primaryMiss`
 * payload (set from a `StepFailed` event whose error_message matches the
 * UI-SPEC-locked `PrimaryMissNoHeal` copy), a destructive block is
 * rendered ABOVE the status pill with an "Open in Simulator" action that
 * routes the user into the Editor on the failed step. The block is
 * focusable + keyboard-operable per WCAG 2.1 AA.
 */
export function RecordingHud({
  projectName,
  projectId,
}: {
  projectName: string;
  projectId?: string | null;
}) {
  const status = useRecorderStore((s) => s.status);
  const elapsedMs = useRecorderStore((s) => s.elapsedMs);
  const primaryMiss = useRecorderStore((s) => s.primaryMiss);
  const active = status === "recording" || status === "paused";

  // The destructive block can outlive `active` — after a primary-miss
  // the status typically flips to "failed" / "idle" but the operator
  // still needs the "Open in Simulator" affordance. Keep rendering the
  // whole HUD (incl. the block) while `primaryMiss` is populated.
  if (!active && !primaryMiss) return null;

  // Clamp ordinal to a positive integer. D-06 threat T-11-02-03 —
  // "Open in Simulator" must not dispatch on an out-of-range value.
  // The executor always emits 1-indexed ordinals; anything else is
  // rejected and the link is omitted.
  const clampedOrdinal =
    primaryMiss && Number.isInteger(primaryMiss.ordinal) && primaryMiss.ordinal >= 1
      ? primaryMiss.ordinal
      : null;
  const body = clampedOrdinal
    ? RECORD_PATH_MISS_BODY.replace("{N}", String(clampedOrdinal))
    : RECORD_PATH_MISS_BODY;
  const simulatorHref =
    clampedOrdinal && projectId
      ? `/editor/${projectId}?step=${clampedOrdinal}`
      : null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
      {primaryMiss ? (
        <div
          role="region"
          aria-labelledby="record-path-miss-heading"
          tabIndex={0}
          className="pointer-events-auto flex min-w-[340px] max-w-[520px] gap-3 rounded-[var(--radius-md)] border-l-4 border-[var(--color-danger)] bg-[var(--color-surface-200)] px-3 py-2 shadow-xl"
        >
          <AlertTriangle
            aria-hidden="true"
            size={16}
            className="mt-[2px] shrink-0 text-[var(--color-danger)]"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div
              id="record-path-miss-heading"
              className="text-[13px] font-medium text-[var(--color-fg-primary)]"
            >
              Step {clampedOrdinal ?? primaryMiss.ordinal}:{" "}
              <span className="inline-block rounded-[4px] bg-[var(--color-surface-300)]/60 px-1.5 py-[1px] font-mono text-[11px] font-medium text-[var(--color-fg-primary)]">
                {primaryMiss.verbExcerpt || "(verb)"}
              </span>{" "}
              could not match any element.
            </div>
            <div className="text-[12px] font-normal leading-[1.4] text-[var(--color-fg-muted)]">
              {body}
            </div>
          </div>
          {simulatorHref ? (
            <Link
              to={simulatorHref}
              aria-label={`Open story in Simulator on step ${clampedOrdinal}`}
              className="self-start whitespace-nowrap text-[12px] font-medium text-[var(--color-accent-primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              Open in Simulator →
            </Link>
          ) : null}
        </div>
      ) : null}

      {active ? (
        <div
          role="status"
          aria-live="polite"
          aria-label={`${status === "paused" ? "Paused" : "Recording"} ${projectName}, elapsed ${formatTime(elapsedMs)}`}
          className="flex items-center gap-3 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]/90 px-4 py-2 shadow-xl backdrop-blur"
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
      ) : null}
    </div>
  );
}

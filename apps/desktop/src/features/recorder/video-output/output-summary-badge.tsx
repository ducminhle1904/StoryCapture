/**
 * Summary badge — small chip next to the Record CTA showing current
 * output knobs; click scrolls the VideoOutputSection into view via the
 * consumer's onActivate.
 */

import { ChevronRight } from "lucide-react";

import { useOutputPrefsStore } from "@/state/output-prefs";

import {
  BADGE_PAD_PREFIX,
  BADGE_TOOLTIP,
  FIT_OPTION_LABELS,
  PAD_OPTION_LABELS,
  QUALITY_OPTION_LABELS,
  RESOLUTION_OPTION_LABELS,
} from "./copy";

function resLabel(
  res: ReturnType<typeof useOutputPrefsStore.getState>["recordingKnobs"]["resolution"],
): string {
  if (res.kind === "custom") return `${res.w}×${res.h}`;
  return RESOLUTION_OPTION_LABELS[res.kind];
}

interface Props {
  onActivate: () => void;
}

export function OutputSummaryBadge({ onActivate }: Props) {
  const knobs = useOutputPrefsStore((s) => s.recordingKnobs);
  const parts = [
    resLabel(knobs.resolution),
    `${knobs.fps}fps`,
    FIT_OPTION_LABELS[knobs.fit],
    QUALITY_OPTION_LABELS[knobs.quality],
  ];
  if (knobs.pad.kind !== "black") {
    parts.push(`${BADGE_PAD_PREFIX} ${PAD_OPTION_LABELS[knobs.pad.kind]}`);
  }
  const text = parts.join(" • ");

  return (
    <button
      type="button"
      onClick={onActivate}
      title={BADGE_TOOLTIP}
      className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-[var(--radius-pill)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1 text-[11px] text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
    >
      <span className="truncate">{text}</span>
      <ChevronRight size={12} aria-hidden="true" className="shrink-0" />
    </button>
  );
}

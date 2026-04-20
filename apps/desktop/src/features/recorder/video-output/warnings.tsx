/**
 * Phase 13 D-13-12 warnings surface.
 * Hard errors render in a red stripe (ResolutionControl already also
 * shows its inline error; this is the roll-up). Soft warnings for
 * Lossless+4K+HW and Output>Capture render in a polite live region.
 */

import { TriangleAlert } from "lucide-react";

import { useOutputPrefsStore } from "@/state/output-prefs";

import { resolveDims } from "./bitrate";
import { WARN_SOFT_LOSSLESS_4K_HW, WARN_SOFT_OUTPUT_GT_CAPTURE } from "./copy";

export interface HardError {
  id: string;
  msg: string;
}

interface Props {
  hardErrors?: HardError[];
  captureDims?: { w: number; h: number };
}

export function Warnings({ hardErrors = [], captureDims }: Props) {
  const resolution = useOutputPrefsStore((s) => s.recordingKnobs.resolution);
  const quality = useOutputPrefsStore((s) => s.recordingKnobs.quality);
  const hwEncoder = useOutputPrefsStore((s) => s.exportKnobs.hwEncoder);

  const out = resolveDims(resolution, captureDims);
  const isHw = hwEncoder !== "software" && hwEncoder !== "auto";
  const is4kOrBigger = out.w * out.h >= 3840 * 2160;
  const soft: string[] = [];
  if (quality === "lossless" && is4kOrBigger && isHw) soft.push(WARN_SOFT_LOSSLESS_4K_HW);
  if (captureDims && (out.w > captureDims.w || out.h > captureDims.h)) {
    soft.push(WARN_SOFT_OUTPUT_GT_CAPTURE);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {hardErrors.map((e) => (
        <p
          key={e.id}
          className="rounded-[var(--radius-sm)] border-l-2 border-[var(--color-danger)] bg-[var(--color-danger)]/5 px-3 py-1.5 text-[11px] text-[var(--color-danger)]"
        >
          {e.msg}
        </p>
      ))}
      <output aria-live="polite" className="flex flex-col gap-1.5">
        {soft.map((msg) => (
          <p
            key={msg}
            className="inline-flex items-start gap-1.5 rounded-[var(--radius-sm)] border-l-2 border-[var(--color-warning)] bg-[var(--color-warning)]/5 px-3 py-1.5 text-[11px] text-[var(--color-fg-secondary)]"
          >
            <TriangleAlert
              size={13}
              className="mt-0.5 shrink-0 text-[var(--color-warning)]"
              aria-hidden="true"
            />
            <span>{msg}</span>
          </p>
        ))}
      </output>
    </div>
  );
}

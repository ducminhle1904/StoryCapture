import { forwardRef, useCallback, useEffect } from "react";
import { create } from "zustand";

import { BitratePreview } from "./bitrate-preview";
import type { ValidationResult } from "./bitrate";
import {
  LABEL_FIT,
  LABEL_FPS,
  LABEL_PAD,
  LABEL_QUALITY,
  LABEL_RESOLUTION,
  SECTION_TITLE,
} from "./copy";
import { FitModeControl } from "./fit-mode-control";
import { FpsControl } from "./fps-control";
import { PadColorControl } from "./pad-color-control";
import { PresetSelect } from "./preset-select";
import { QualityPresetControl } from "./quality-preset-control";
import { ResolutionControl } from "./resolution-control";
import { Warnings } from "./warnings";

type HardError = (ValidationResult & { valid: false }) | null;

interface BlockedStore {
  customErr: HardError;
  setCustomErr: (e: HardError) => void;
}

const useBlockedStore = create<BlockedStore>((set) => ({
  customErr: null,
  setCustomErr: (e) =>
    set((s) => {
      if (!s.customErr && !e) return s;
      if (s.customErr && e && s.customErr.reason === e.reason) return s;
      return { customErr: e };
    }),
}));

export function useIsRecordingBlocked(): boolean {
  return useBlockedStore((s) => s.customErr !== null);
}

interface Props {
  disabled?: boolean;
  captureDims?: { w: number; h: number };
}

export const VideoOutputSection = forwardRef<HTMLDivElement, Props>(function VideoOutputSection(
  { disabled, captureDims },
  ref,
) {
  const setCustomErr = useBlockedStore((s) => s.setCustomErr);

  const handleError = useCallback((e: HardError) => setCustomErr(e), [setCustomErr]);

  useEffect(() => () => setCustomErr(null), [setCustomErr]);

  return (
    <section
      ref={ref}
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3"
    >
      <header className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-fg-primary)]">
          {SECTION_TITLE}
        </h3>
        <PresetSelect disabled={disabled} />
      </header>

      <div className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-3 gap-y-3">
        <span aria-hidden="true" className="pt-1.5 text-xs text-[var(--color-fg-muted)]">
          {LABEL_RESOLUTION}
        </span>
        <div>
          <ResolutionControl disabled={disabled} onErrorChange={handleError} />
        </div>

        <span aria-hidden="true" className="pt-1.5 text-xs text-[var(--color-fg-muted)]">
          {LABEL_FPS}
        </span>
        <div>
          <FpsControl disabled={disabled} />
        </div>

        <span aria-hidden="true" className="pt-1.5 text-xs text-[var(--color-fg-muted)]">
          {LABEL_FIT}
        </span>
        <div>
          <FitModeControl disabled={disabled} />
        </div>

        <span aria-hidden="true" className="pt-1.5 text-xs text-[var(--color-fg-muted)]">
          {LABEL_PAD}
        </span>
        <div>
          <PadColorControl disabled={disabled} />
        </div>

        <span aria-hidden="true" className="pt-1.5 text-xs text-[var(--color-fg-muted)]">
          {LABEL_QUALITY}
        </span>
        <div>
          <QualityPresetControl disabled={disabled} />
        </div>
      </div>

      <BitratePreview captureDims={captureDims} />
      <Warnings captureDims={captureDims} />
    </section>
  );
});

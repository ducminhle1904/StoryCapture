/**
 * FPS knob — 24 / 30 / 60 options as a horizontal RadioGroup.
 */

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useOutputPrefsStore } from "@/state/output-prefs";
import { LABEL_FPS } from "./copy";

const OPTIONS = [24, 30, 60] as const;

interface Props {
  disabled?: boolean;
}

export function FpsControl({ disabled }: Props) {
  const fps = useOutputPrefsStore((s) => s.recordingKnobs.fps);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);

  return (
    <RadioGroup
      aria-label={LABEL_FPS}
      value={String(fps)}
      onValueChange={(raw) => {
        if (typeof raw !== "string") return;
        const n = Number(raw);
        if (Number.isFinite(n)) setKnob("fps", n);
      }}
      disabled={disabled}
      className="flex flex-row items-center gap-4"
    >
      {OPTIONS.map((n) => {
        const id = `fps-${n}`;
        return (
          <span
            key={n}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--color-fg-secondary)]"
          >
            <RadioGroupItem id={id} value={String(n)} />
            <label htmlFor={id} className="cursor-pointer">
              {n}
            </label>
          </span>
        );
      })}
    </RadioGroup>
  );
}

/**
 * Quality preset knob (standard / lossless). Horizontal
 * RadioGroup mirroring FpsControl.
 */

import { ScRadioGroup as RadioGroup, ScRadioGroupItem as RadioGroupItem } from "@storycapture/ui";
import { type RecordingQualityPreset, useOutputPrefsStore } from "@/state/output-prefs";

import { LABEL_QUALITY, QUALITY_OPTION_LABELS } from "./copy";

const ORDER = ["high", "lossless"] as const satisfies readonly RecordingQualityPreset[];

interface Props {
  disabled?: boolean;
}

export function QualityPresetControl({ disabled }: Props) {
  const quality = useOutputPrefsStore((s) => s.recordingKnobs.quality);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);

  return (
    <RadioGroup
      aria-label={LABEL_QUALITY}
      value={quality}
      onValueChange={(raw) => {
        if (typeof raw !== "string") return;
        if ((ORDER as readonly string[]).includes(raw)) setKnob("quality", raw as RecordingQualityPreset);
      }}
      disabled={disabled}
      className="flex flex-row flex-wrap items-center gap-3"
    >
      {ORDER.map((k) => {
        const id = `quality-${k}`;
        return (
          <span
            key={k}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--color-fg-secondary)]"
          >
            <RadioGroupItem id={id} value={k} />
            <label htmlFor={id} className="cursor-pointer">
              {QUALITY_OPTION_LABELS[k]}
            </label>
          </span>
        );
      })}
    </RadioGroup>
  );
}

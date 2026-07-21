/**
 * Quality preset knob (standard / lossless). Horizontal
 * Astryx RadioList mirroring FpsControl.
 */

import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
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
    <RadioList
      label={LABEL_QUALITY}
      isLabelHidden
      value={quality}
      onChange={(raw) => {
        if ((ORDER as readonly string[]).includes(raw))
          setKnob("quality", raw as RecordingQualityPreset);
      }}
      isDisabled={disabled}
      orientation="horizontal"
      size="sm"
    >
      {ORDER.map((qualityOption) => (
        <RadioListItem
          key={qualityOption}
          value={qualityOption}
          label={QUALITY_OPTION_LABELS[qualityOption]}
        />
      ))}
    </RadioList>
  );
}

/**
 * Fit-mode knob. Single-select Astryx ToggleButtonGroup over the 3 FitModeDto values:
 * letterbox / fill-crop / stretch.
 */

import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import type { FitModeDto } from "@storycapture/shared-types";
import { useOutputPrefsStore } from "@/state/output-prefs";

import { FIT_OPTION_LABELS, LABEL_FIT } from "./copy";

const ORDER: FitModeDto[] = ["letterbox", "fill-crop", "stretch"];

interface Props {
  disabled?: boolean;
}

export function FitModeControl({ disabled }: Props) {
  const fit = useOutputPrefsStore((s) => s.recordingKnobs.fit);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);

  return (
    <ToggleButtonGroup
      label={LABEL_FIT}
      value={fit}
      onChange={(next) => {
        if (next && (ORDER as string[]).includes(next)) {
          setKnob("fit", next as FitModeDto);
        }
      }}
      isDisabled={disabled}
      size="sm"
    >
      {ORDER.map((k) => (
        <ToggleButton key={k} value={k} label={FIT_OPTION_LABELS[k]} />
      ))}
    </ToggleButtonGroup>
  );
}

/**
 * Fit-mode knob. Single-select ToggleGroup over the 3 FitModeDto values:
 * letterbox / fill-crop / stretch.
 */

import type { FitModeDto } from "@storycapture/shared-types";

import { ScToggleGroup as ToggleGroup, ScToggleGroupItem as ToggleGroupItem } from "@storycapture/ui";
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
    <ToggleGroup
      aria-label={LABEL_FIT}
      value={[fit]}
      onValueChange={(next) => {
        const v = next[0];
        if (typeof v === "string" && (ORDER as string[]).includes(v)) {
          setKnob("fit", v as FitModeDto);
        }
      }}
      disabled={disabled}
    >
      {ORDER.map((k) => (
        <ToggleGroupItem key={k} value={k}>
          {FIT_OPTION_LABELS[k]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

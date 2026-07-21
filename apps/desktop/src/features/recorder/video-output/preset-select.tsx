/**
 * Preset selector. Applies the bundled presets via applyPreset; the
 * "Custom" label is display-only — never user-applied (setRecordingKnob
 * flips the activePreset automatically).
 */

import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { type PresetName, useOutputPrefsStore } from "@/state/output-prefs";
import { LABEL_PRESET, PRESET_OPTION_LABELS } from "./copy";

const APPLICABLE: Array<Exclude<PresetName, "Custom">> = ["Standard", "Lossless"];

interface Props {
  disabled?: boolean;
}

export function PresetSelect({ disabled }: Props) {
  const activePreset = useOutputPrefsStore((s) => s.activePreset);
  const applyPreset = useOutputPrefsStore((s) => s.applyPreset);

  return (
    <AstryxSelector
      label={LABEL_PRESET}
      isLabelHidden
      value={activePreset}
      options={[
        ...APPLICABLE.map((name) => ({ value: name, label: PRESET_OPTION_LABELS[name] })),
        { value: "Custom", label: PRESET_OPTION_LABELS.Custom, disabled: true },
      ]}
      onChange={(raw) => {
        if (raw === "Custom") return;
        applyPreset(raw as Exclude<PresetName, "Custom">);
      }}
      isDisabled={disabled}
      width="100%"
    />
  );
}

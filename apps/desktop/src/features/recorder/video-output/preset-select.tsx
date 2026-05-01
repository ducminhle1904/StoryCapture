/**
 * Preset selector. Applies the bundled presets via applyPreset; the
 * "Custom" label is display-only — never user-applied (setRecordingKnob
 * flips the activePreset automatically).
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    <Select
      value={activePreset}
      onValueChange={(raw) => {
        if (typeof raw !== "string") return;
        if (raw === "Custom") return;
        applyPreset(raw as Exclude<PresetName, "Custom">);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label={LABEL_PRESET} className="w-full min-w-0">
        <SelectValue>{PRESET_OPTION_LABELS[activePreset]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {APPLICABLE.map((name) => (
            <SelectItem key={name} value={name}>
              {PRESET_OPTION_LABELS[name]}
            </SelectItem>
          ))}
          <SelectItem value="Custom" disabled>
            {PRESET_OPTION_LABELS.Custom}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

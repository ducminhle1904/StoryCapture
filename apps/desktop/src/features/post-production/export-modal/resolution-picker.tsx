/**
 * ResolutionPicker — single-select radio group for source / presets / custom.
 * `export_validate_config` is the authoritative source on
 * format+resolution compatibility; this component just captures the
 * user's pick.
 */

import { NumberInput } from "@astryxdesign/core/NumberInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { memo } from "react";

import type { ExportResolution } from "../state/export-slice";

const OPTIONS: Array<{ id: ExportResolution; label: string }> = [
  { id: "match-source", label: "Source" },
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
  { id: "4k", label: "4K" },
  { id: "custom", label: "Custom" },
];

export interface ResolutionPickerProps {
  value: ExportResolution;
  customWidth: number;
  customHeight: number;
  onChange: (next: ExportResolution) => void;
  onCustomSizeChange: (next: { width: number; height: number }) => void;
}

function ResolutionPickerBase({
  value,
  customWidth,
  customHeight,
  onChange,
  onCustomSizeChange,
}: ResolutionPickerProps) {
  return (
    <div className="space-y-3">
      <RadioList
        label="Resolution"
        value={value}
        onChange={(next) => onChange(next as ExportResolution)}
        orientation="horizontal"
        size="sm"
        htmlName="export-resolution"
      >
        {OPTIONS.map((option) => (
          <RadioListItem key={option.id} value={option.id} label={option.label} />
        ))}
      </RadioList>
      {value === "custom" ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="Width"
            min={16}
            max={7680}
            step={2}
            value={customWidth}
            onChange={(width) => onCustomSizeChange({ width, height: customHeight })}
            width="100%"
          />
          <NumberInput
            label="Height"
            min={16}
            max={4320}
            step={2}
            value={customHeight}
            onChange={(height) => onCustomSizeChange({ width: customWidth, height })}
            width="100%"
          />
        </div>
      ) : null}
    </div>
  );
}

export const ResolutionPicker = memo(ResolutionPickerBase);

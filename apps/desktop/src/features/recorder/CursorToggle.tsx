/**
 * Per-recording real OS cursor switch. Non-sticky, defaults OFF because
 * polished demo cursor paths are synthesized later in Post Production.
 * The bool reaches both SCK `with_shows_cursor` and WGC
 * `CursorCaptureSettings` via `StartRecordingArgs.include_cursor`.
 */

import { Switch } from "@astryxdesign/core/Switch";

interface CursorToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function CursorToggle({ checked, onChange, disabled }: CursorToggleProps) {
  return (
    <Switch
      label="Capture real cursor"
      description="Include the real OS cursor in the raw recording."
      value={checked}
      onChange={onChange}
      isDisabled={disabled}
      disabledMessage="Recording controls are currently locked"
      labelPosition="start"
      labelSpacing="spread"
      width="100%"
    />
  );
}

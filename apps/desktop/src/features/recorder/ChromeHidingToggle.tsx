/**
 * Per-recording switch for Chromium app-mode (`--app=<meta.app>`): no
 * tab bar, no URL bar, no back/forward. Disabled for non-Chromium
 * presets since Safari/Firefox have no equivalent flag. Non-sticky —
 * the recorder-state field resets to false on mount and after reset().
 */

import { Switch } from "@astryxdesign/core/Switch";
import { isChromiumFamily } from "@/features/settings/browser-presets";

interface ChromeHidingToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The active BrowserRow preset label / exec path. Null = bundled
   *  Playwright Chromium (also Chromium-family, enabled). */
  browserPreset: string | null;
  disabled?: boolean;
}

export function ChromeHidingToggle({
  checked,
  onChange,
  browserPreset,
  disabled,
}: ChromeHidingToggleProps) {
  const chromiumOk = isChromiumFamily(browserPreset);
  const effectiveDisabled = disabled || !chromiumOk;
  return (
    <Switch
      label="Hide browser chrome"
      description="Launch Chromium in app mode without tabs or the URL bar."
      value={checked}
      onChange={onChange}
      isDisabled={effectiveDisabled}
      disabledMessage={
        chromiumOk
          ? "Recording controls are currently locked"
          : "Chrome-hiding requires Chrome, Edge, Brave, or another Chromium browser"
      }
      labelPosition="start"
      labelSpacing="spread"
      width="100%"
    />
  );
}

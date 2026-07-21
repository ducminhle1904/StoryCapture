import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import type { AudioInputDefault, CaptureDefaults } from "@/ipc/settings";
import { notifications } from "@/lib/notifications";
import { useAppSettingsStore } from "@/state/app-settings";
import { applyCaptureFpsDefault } from "@/state/output-prefs";
import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

export function CaptureCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchCapture = useAppSettingsStore((s) => s.patchCapture);

  const saveCapture = async (patch: Partial<CaptureDefaults>) => {
    try {
      const next = await patchCapture(patch);
      if (patch.capture_fps != null) {
        applyCaptureFpsDefault(next.capture);
      }
      notifications.success("Capture defaults saved");
    } catch (err) {
      notifications.error("Could not save capture defaults", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!settings) {
    return <SettingsPanel title="Capture defaults">Loading settings...</SettingsPanel>;
  }

  return (
    <SettingsPanel
      title="Capture defaults"
      desc="Defaults used when a new Recorder session opens. Runtime backend selection remains automatic."
    >
      <SettingsCard>
        <SettingsRow
          label="Capture fps"
          hint="Used by new recordings and the recorder output controls."
          control={
            <AstryxSegmentedControl
              size="sm"
              value={String(settings.capture.capture_fps)}
              onChange={(value) => void saveCapture({ capture_fps: Number(value) })}
              label="Capture frame rate"
            >
              {[
                { value: "24", label: "24" },
                { value: "30", label: "30" },
                { value: "60", label: "60" },
              ].map((option) => (
                <AstryxSegmentedControlItem
                  key={option.value}
                  value={option.value}
                  label={typeof option.label === "string" ? option.label : option.value}
                  icon={typeof option.label === "string" ? undefined : option.label}
                />
              ))}
            </AstryxSegmentedControl>
          }
        />
        <SettingsRow
          label="Capture cursor"
          hint="Default for the raw OS cursor switch in Recorder."
          control={
            <AstryxSwitch
              label="Capture cursor"
              isLabelHidden
              value={settings.capture.include_cursor_default}
              onChange={(checked) => void saveCapture({ include_cursor_default: checked })}
            />
          }
        />
        <SettingsRow
          label="Audio input"
          hint="Recorder still enumerates devices lazily to avoid microphone prompts."
          control={
            <AstryxSegmentedControl
              size="sm"
              value={settings.capture.audio_input_default}
              onChange={(value) =>
                void saveCapture({ audio_input_default: value as AudioInputDefault })
              }
              label="Audio input"
            >
              {[
                { value: "none", label: "Off" },
                { value: "system_default", label: "System default" },
              ].map((option) => (
                <AstryxSegmentedControlItem
                  key={option.value}
                  value={option.value}
                  label={typeof option.label === "string" ? option.label : option.value}
                  icon={typeof option.label === "string" ? undefined : option.label}
                />
              ))}
            </AstryxSegmentedControl>
          }
        />
        <SettingsRow
          label="Color profile"
          hint="Current capture and encoder pipeline normalizes to sRGB / Rec.709."
          control={<AstryxBadge variant="neutral" label="sRGB / Rec.709" />}
          last
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

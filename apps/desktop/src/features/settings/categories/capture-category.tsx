import { toast } from "sonner";
import { ScBadge, ScSegmented, ScSwitch } from "@storycapture/ui";

import type { AudioInputDefault, CaptureDefaults } from "@/ipc/settings";
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
      toast.success("Capture defaults saved");
    } catch (err) {
      toast.error("Could not save capture defaults", {
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
            <ScSegmented
              size="sm"
              value={String(settings.capture.capture_fps)}
              onValueChange={(value) => void saveCapture({ capture_fps: Number(value) })}
              options={[
                { value: "24", label: "24" },
                { value: "30", label: "30" },
                { value: "60", label: "60" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Capture cursor"
          hint="Default for the raw OS cursor switch in Recorder."
          control={
            <ScSwitch
              checked={settings.capture.include_cursor_default}
              onCheckedChange={(checked) =>
                void saveCapture({ include_cursor_default: checked })
              }
            />
          }
        />
        <SettingsRow
          label="Audio input"
          hint="Recorder still enumerates devices lazily to avoid microphone prompts."
          control={
            <ScSegmented
              size="sm"
              value={settings.capture.audio_input_default}
              onValueChange={(value) =>
                void saveCapture({ audio_input_default: value as AudioInputDefault })
              }
              options={[
                { value: "none", label: "Off" },
                { value: "system_default", label: "System default" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Color profile"
          hint="Current capture and encoder pipeline normalizes to sRGB / Rec.709."
          control={<ScBadge tone="muted">sRGB / Rec.709</ScBadge>}
          last
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

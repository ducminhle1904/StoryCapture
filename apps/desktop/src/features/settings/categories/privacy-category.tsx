import { open } from "@tauri-apps/plugin-dialog";
import { FolderArchive } from "lucide-react";
import { toast } from "sonner";
import { ScBadge, ScButton, ScSwitch } from "@storycapture/ui";

import { exportDiagnosticBundle, type PrivacySettings } from "@/ipc/settings";
import { useAppSettingsStore } from "@/state/app-settings";
import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

export function PrivacyCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchPrivacy = useAppSettingsStore((s) => s.patchPrivacy);

  const savePrivacy = async (patch: Partial<PrivacySettings>) => {
    try {
      await patchPrivacy(patch);
      toast.success("Privacy settings saved");
    } catch (err) {
      toast.error("Could not save privacy settings", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const exportBundle = async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select folder for diagnostic bundle",
    });
    if (typeof selected !== "string") return;
    try {
      const result = await exportDiagnosticBundle(selected);
      toast.success("Diagnostic bundle exported", {
        description: result.path,
      });
    } catch (err) {
      toast.error("Could not export diagnostic bundle", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!settings) {
    return <SettingsPanel title="Privacy & telemetry">Loading settings...</SettingsPanel>;
  }

  return (
    <SettingsPanel
      title="Privacy & telemetry"
      desc="Telemetry remains local-only. Story content and recordings are never included in diagnostic bundles."
    >
      <SettingsCard>
        <SettingsRow
          label="Crash reports"
          hint="Local log capture only; no automatic upload."
          control={<ScBadge tone="muted">Off</ScBadge>}
        />
        <SettingsRow
          label="Usage analytics"
          hint="No product analytics are collected."
          control={<ScBadge tone="muted">Off</ScBadge>}
        />
        <SettingsRow
          label="Prompt redaction"
          hint="Redact user prompt content from local diagnostic exports where possible."
          control={
            <ScSwitch
              checked={settings.privacy.prompt_redaction_enabled}
              onCheckedChange={(checked) =>
                void savePrivacy({ prompt_redaction_enabled: checked })
              }
            />
          }
        />
        <SettingsRow
          label="Diagnostic bundle"
          hint="Exports logs and app metadata only."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ScSwitch
                checked={settings.privacy.diagnostic_bundle_enabled}
                onCheckedChange={(checked) =>
                  void savePrivacy({ diagnostic_bundle_enabled: checked })
                }
              />
              <ScButton
                size="sm"
                variant="ghost"
                onClick={() => void exportBundle()}
                disabled={!settings.privacy.diagnostic_bundle_enabled}
              >
                <FolderArchive size={12} /> Export
              </ScButton>
            </div>
          }
          last
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

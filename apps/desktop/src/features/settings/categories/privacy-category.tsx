import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderArchive } from "lucide-react";
import { exportDiagnosticBundle, type PrivacySettings } from "@/ipc/settings";
import { notifications } from "@/lib/notifications";
import { useAppSettingsStore } from "@/state/app-settings";
import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

export function PrivacyCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchPrivacy = useAppSettingsStore((s) => s.patchPrivacy);

  const savePrivacy = async (patch: Partial<PrivacySettings>) => {
    try {
      await patchPrivacy(patch);
      notifications.success("Privacy settings saved");
    } catch (err) {
      notifications.error("Could not save privacy settings", {
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
      notifications.success("Diagnostic bundle exported", {
        description: result.path,
      });
    } catch (err) {
      notifications.error("Could not export diagnostic bundle", {
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
          control={<AstryxBadge variant="neutral" label="Off" />}
        />
        <SettingsRow
          label="Usage analytics"
          hint="No product analytics are collected."
          control={<AstryxBadge variant="neutral" label="Off" />}
        />
        <SettingsRow
          label="Prompt redaction"
          hint="Redact user prompt content from local diagnostic exports where possible."
          control={
            <AstryxSwitch
              label="Prompt redaction"
              isLabelHidden
              value={settings.privacy.prompt_redaction_enabled}
              onChange={(checked) => void savePrivacy({ prompt_redaction_enabled: checked })}
            />
          }
        />
        <SettingsRow
          label="Diagnostic bundle"
          hint="Exports logs and app metadata only."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AstryxSwitch
                label="Diagnostic bundle"
                isLabelHidden
                value={settings.privacy.diagnostic_bundle_enabled}
                onChange={(checked) => void savePrivacy({ diagnostic_bundle_enabled: checked })}
              />
              <AstryxButton
                size="sm"
                variant="ghost"
                onClick={() => void exportBundle()}
                isDisabled={!settings.privacy.diagnostic_bundle_enabled}
                label="Export"
              >
                <FolderArchive size={12} /> Export
              </AstryxButton>
            </div>
          }
          last
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

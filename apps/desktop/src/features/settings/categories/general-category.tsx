import { Button as AstryxButton } from "@astryxdesign/core/Button";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { GeneralSettings, StartupBehavior } from "@/ipc/settings";
import { notifications } from "@/lib/notifications";
import { useAppSettingsStore } from "@/state/app-settings";
import { BrowserLanguageRow } from "../BrowserLanguageRow";
import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

export function GeneralCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchGeneral = useAppSettingsStore((s) => s.patchGeneral);

  const saveGeneral = async (patch: Partial<GeneralSettings>) => {
    try {
      await patchGeneral(patch);
      notifications.success("General settings saved");
    } catch (err) {
      notifications.error("Could not save general settings", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const pickProjectsFolder = async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select default projects folder",
    });
    if (typeof selected === "string") {
      await saveGeneral({ projects_folder: selected });
    }
  };

  if (!settings) {
    return <SettingsPanel title="General">Loading settings...</SettingsPanel>;
  }

  return (
    <SettingsPanel title="General">
      <SettingsCard>
        <SettingsRow
          label="Projects folder"
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AstryxTextInput
                label="Projects folder"
                isLabelHidden
                value={settings.general.projects_folder ?? settings.default_projects_folder}
                startIcon={<FolderOpen size={12} />}
                isDisabled
                disabledMessage="Use Browse to change the projects folder"
                style={{ width: 280 }}
              />
              <AstryxButton
                size="sm"
                variant="ghost"
                onClick={() => void pickProjectsFolder()}
                tooltip="Choose default projects folder"
                label="Choose default projects folder"
              >
                Browse
              </AstryxButton>
            </div>
          }
        />
        <SettingsRow
          label="Startup"
          control={
            <AstryxSegmentedControl
              size="sm"
              value={settings.general.startup_behavior}
              onChange={(value) => void saveGeneral({ startup_behavior: value as StartupBehavior })}
              label="Startup behavior"
            >
              {[
                { value: "welcome", label: "Welcome" },
                { value: "last_project", label: "Last project" },
                { value: "new_story", label: "New story" },
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
          label="Auto-save"
          hint={`Every ${settings.general.autosave_interval_sec} seconds`}
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AstryxSwitch
                label="Auto-save"
                isLabelHidden
                value={settings.general.autosave_enabled}
                onChange={(checked) => void saveGeneral({ autosave_enabled: checked })}
              />
              <AstryxSegmentedControl
                size="sm"
                value={String(settings.general.autosave_interval_sec)}
                onChange={(value) => void saveGeneral({ autosave_interval_sec: Number(value) })}
                label="Auto-save interval"
              >
                {[
                  { value: "5", label: "5s" },
                  { value: "12", label: "12s" },
                  { value: "30", label: "30s" },
                ].map((option) => (
                  <AstryxSegmentedControlItem
                    key={option.value}
                    value={option.value}
                    label={typeof option.label === "string" ? option.label : option.value}
                    icon={typeof option.label === "string" ? undefined : option.label}
                  />
                ))}
              </AstryxSegmentedControl>
            </div>
          }
        />
        <SettingsRow
          label="Progress badge"
          hint={
            settings.dock_progress_badge_supported
              ? "Show global recording/render progress badges where supported"
              : "Controls the in-app recording badge; OS dock badge support is not available here"
          }
          control={
            <AstryxSwitch
              label="Progress badge"
              isLabelHidden
              value={settings.general.dock_progress_badge}
              onChange={(checked) => void saveGeneral({ dock_progress_badge: checked })}
            />
          }
          last
        />
      </SettingsCard>

      <div style={{ marginTop: 28 }}>
        <h3
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--color-text-disabled)",
            marginBottom: 6,
          }}
        >
          Automation
        </h3>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          Browser language used by Live Preview, Simulator, and Record.
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <BrowserLanguageRow />
        </div>
      </div>
    </SettingsPanel>
  );
}

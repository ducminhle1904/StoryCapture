import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { ScButton, ScInput, ScSegmented, ScSwitch } from "@storycapture/ui";

import { BrowserLanguageRow } from "../BrowserLanguageRow";
import {
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";
import { useAppSettingsStore } from "@/state/app-settings";
import type { GeneralSettings, StartupBehavior } from "@/ipc/settings";

export function GeneralCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchGeneral = useAppSettingsStore((s) => s.patchGeneral);

  const saveGeneral = async (patch: Partial<GeneralSettings>) => {
    try {
      await patchGeneral(patch);
      toast.success("General settings saved");
    } catch (err) {
      toast.error("Could not save general settings", {
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
              <ScInput
                value={settings.general.projects_folder ?? settings.default_projects_folder}
                icon={<FolderOpen size={12} />}
                readOnly
                style={{ width: 280 }}
              />
              <ScButton
                size="sm"
                variant="ghost"
                onClick={() => void pickProjectsFolder()}
                title="Choose default projects folder"
              >
                Browse
              </ScButton>
            </div>
          }
        />
        <SettingsRow
          label="Startup"
          control={
            <ScSegmented
              size="sm"
              value={settings.general.startup_behavior}
              onValueChange={(value) =>
                void saveGeneral({ startup_behavior: value as StartupBehavior })
              }
              options={[
                { value: "welcome", label: "Welcome" },
                { value: "last_project", label: "Last project" },
                { value: "new_story", label: "New story" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Auto-save"
          hint={`Every ${settings.general.autosave_interval_sec} seconds`}
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <ScSwitch
                checked={settings.general.autosave_enabled}
                onCheckedChange={(checked) => void saveGeneral({ autosave_enabled: checked })}
              />
              <ScSegmented
                size="sm"
                value={String(settings.general.autosave_interval_sec)}
                onValueChange={(value) =>
                  void saveGeneral({ autosave_interval_sec: Number(value) })
                }
                options={[
                  { value: "5", label: "5s" },
                  { value: "12", label: "12s" },
                  { value: "30", label: "30s" },
                ]}
              />
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
            <ScSwitch
              checked={settings.general.dock_progress_badge}
              onCheckedChange={(checked) => void saveGeneral({ dock_progress_badge: checked })}
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
            color: "var(--sc-text-4)",
            marginBottom: 6,
          }}
        >
          Automation
        </h3>
        <div style={{ fontSize: 12, color: "var(--sc-text-3)", marginBottom: 12 }}>
          Browser language used by Live Preview, Simulator, and Record.
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <BrowserLanguageRow />
        </div>
      </div>
    </SettingsPanel>
  );
}

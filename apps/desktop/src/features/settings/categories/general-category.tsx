import { FolderOpen } from "lucide-react";
import { ScInput, ScSegmented, ScSwitch } from "@storycapture/ui";

import {
  NotWiredCaption,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";

// Placeholder: no general-prefs store wired yet.
export function GeneralCategory() {
  return (
    <SettingsPanel title="General">
      <SettingsCard>
        <SettingsRow
          label="Projects folder"
          control={
            <ScInput
              value="~/Documents/StoryCapture"
              icon={<FolderOpen size={12} />}
              readOnly
              disabled
              style={{ width: 280 }}
            />
          }
        />
        <SettingsRow
          label="Startup"
          control={
            <ScSegmented
              size="sm"
              value="last"
              disabled
              options={[
                { value: "welcome", label: "Welcome" },
                { value: "last", label: "Last project" },
                { value: "new", label: "New story" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Auto-save"
          hint="Every 12 seconds"
          control={<ScSwitch checked disabled />}
        />
        <SettingsRow
          label="Dock badge"
          hint="Show render progress on dock icon"
          control={<ScSwitch checked disabled />}
          last
        />
      </SettingsCard>
      <NotWiredCaption>Not yet wired — values shown are defaults.</NotWiredCaption>
    </SettingsPanel>
  );
}

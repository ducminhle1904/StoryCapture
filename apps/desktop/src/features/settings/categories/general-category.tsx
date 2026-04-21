import { FolderOpen } from "lucide-react";
import { ScInput, ScSegmented, ScSwitch } from "@storycapture/ui";

import { BrowserRow } from "../BrowserRow";
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
          Any Chromium-based browser works (Chrome, Brave, Edge, Arc, Chromium).
        </div>
        <BrowserRow />
      </div>
    </SettingsPanel>
  );
}

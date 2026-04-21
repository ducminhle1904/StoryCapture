import { ScSwitch } from "@storycapture/ui";

import {
  NotWiredCaption,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";

// Telemetry is off by default per CLAUDE.md; switches are disabled placeholders
// until an opt-in diagnostic-upload flow ships.
export function PrivacyCategory() {
  return (
    <SettingsPanel
      title="Privacy & telemetry"
      desc="Telemetry is off by default. Nothing about your stories, prompts, or recordings leaves your machine unless you explicitly share."
    >
      <SettingsCard>
        <SettingsRow
          label="Crash reports"
          hint="Anonymized stack traces only"
          control={<ScSwitch checked={false} disabled />}
        />
        <SettingsRow
          label="Usage analytics"
          hint="Feature counts; no content"
          control={<ScSwitch checked={false} disabled />}
        />
        <SettingsRow
          label="Auto-update"
          hint="Managed under About → Updates"
          control={<ScSwitch checked disabled />}
        />
        <SettingsRow
          label="Prompt redaction"
          hint="Strip values from .story before sending to LLM"
          control={<ScSwitch checked disabled />}
          last
        />
      </SettingsCard>
      <div
        style={{
          marginTop: 16,
          padding: 14,
          background: "var(--sc-surface-2)",
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-md)",
          fontSize: 12,
          color: "var(--sc-text-3)",
          lineHeight: 1.5,
        }}
      >
        Diagnostic bundle export is opt-in only and never auto-uploaded. Bundle
        export UI arrives with the privacy settings plan.
      </div>
      <NotWiredCaption>
        Telemetry toggles are disabled by design — the app does not collect
        analytics today.
      </NotWiredCaption>
    </SettingsPanel>
  );
}

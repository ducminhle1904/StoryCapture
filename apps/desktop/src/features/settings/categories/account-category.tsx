import { WebAccountPanel } from "../accounts-panel";
import { SettingsPanel } from "../settings-row";

export function AccountCategory() {
  return (
    <SettingsPanel
      title="Web account"
      desc="Connect only when you want upload, sharing, or sync. Local editing and recording continue without an account."
    >
      <WebAccountPanel />
    </SettingsPanel>
  );
}


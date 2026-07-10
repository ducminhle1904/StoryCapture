import { SETTINGS_SHORTCUTS } from "@/lib/shortcuts";
import { SettingsPanel } from "../settings-row";

export function KeyboardCategory() {
  return (
    <SettingsPanel
      title="Keyboard shortcuts"
      desc="Reference for the shortcuts currently registered by the workspace and editor command palettes."
    >
      <div
        style={{
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-lg)",
          background: "var(--sc-surface)",
        }}
      >
        {SETTINGS_SHORTCUTS.map((shortcut, i) => (
          <div
            key={shortcut.id}
            style={{
              display: "flex",
              padding: "10px 16px",
              borderBottom:
                i < SETTINGS_SHORTCUTS.length - 1 ? "1px solid var(--sc-border)" : "none",
              fontSize: 12.5,
            }}
          >
            <span style={{ flex: 1 }}>{shortcut.label}</span>
            <span className="sc-kbd">{shortcut.keys}</span>
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}

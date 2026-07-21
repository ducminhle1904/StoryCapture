import { Kbd as AstryxKbd } from "@astryxdesign/core/Kbd";
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
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-container)",
          background: "var(--color-background-surface)",
        }}
      >
        {SETTINGS_SHORTCUTS.map((shortcut, i) => (
          <div
            key={shortcut.id}
            style={{
              display: "flex",
              padding: "10px 16px",
              borderBottom:
                i < SETTINGS_SHORTCUTS.length - 1 ? "1px solid var(--color-border)" : "none",
              fontSize: 12.5,
            }}
          >
            <span style={{ flex: 1 }}>{shortcut.label}</span>
            <AstryxKbd keys={shortcut.keys} />
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}

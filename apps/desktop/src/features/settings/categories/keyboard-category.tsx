import { SettingsPanel } from "../settings-row";

// Static shortcut list. Reflects hotkeys registered in Dashboard (14-03a),
// CommandPalette, and EditorHotkeys. Rebinding is not yet wired.
const ROWS: [string, string][] = [
  ["Command palette", "⌘ K"],
  ["New story", "⌘ N"],
  ["Focus search", "⌘ F"],
  ["Run scene", "⌘ ↵"],
  ["Record", "⌘ ⇧ R"],
  ["Split clip", "⌘ K"],
  ["Toggle preview", "⌘ ."],
  ["Open project", "⌘ O"],
  ["Export", "⌘ E"],
];

export function KeyboardCategory() {
  return (
    <SettingsPanel title="Keyboard shortcuts">
      <div
        style={{
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-lg)",
          background: "var(--sc-surface)",
        }}
      >
        {ROWS.map(([label, keys], i) => (
          <div
            key={label}
            style={{
              display: "flex",
              padding: "10px 16px",
              borderBottom:
                i < ROWS.length - 1 ? "1px solid var(--sc-border)" : "none",
              fontSize: 12.5,
            }}
          >
            <span style={{ flex: 1 }}>{label}</span>
            <span className="sc-kbd">{keys}</span>
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}

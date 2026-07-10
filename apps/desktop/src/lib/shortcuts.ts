export interface ShortcutDefinition {
  id: string;
  label: string;
  keys: string;
}

export const GLOBAL_SHORTCUTS: ShortcutDefinition[] = [
  { id: "command-palette", label: "Command palette", keys: "⌘ K" },
  { id: "new-story", label: "New story", keys: "⌘ N" },
  { id: "settings", label: "Open Settings", keys: "⌘ ," },
  { id: "record", label: "Record", keys: "⌘ ⇧ R" },
  { id: "export", label: "Export", keys: "⌘ E" },
  { id: "focus-search", label: "Focus search", keys: "⌘ F" },
];

export const EDITOR_SHORTCUTS: ShortcutDefinition[] = [
  { id: "editor-palette", label: "Editor command palette", keys: "⌘ ⇧ K" },
  { id: "run-scene", label: "Run simulator from top", keys: "⌘ ⇧ ." },
  { id: "run-to-cursor", label: "Run to cursor", keys: "⌘ ." },
  { id: "toggle-comment", label: "Toggle line comment", keys: "⌘ /" },
  { id: "toggle-preview", label: "Toggle preview", keys: "⌘ ." },
];

export const SETTINGS_SHORTCUTS: ShortcutDefinition[] = [...GLOBAL_SHORTCUTS, ...EDITOR_SHORTCUTS];

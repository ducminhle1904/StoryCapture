export interface EditorLayoutPreferences {
  splitRatio: number;
  authorCollapsed: boolean;
  previewFocused: boolean;
}

export const EDITOR_LAYOUT_STORAGE_KEY = "storycapture.editor.layout.v1";
export const DEFAULT_EDITOR_LAYOUT: EditorLayoutPreferences = {
  splitRatio: 46,
  authorCollapsed: false,
  previewFocused: false,
};

export type EditorWorkspaceMode = "author" | "preview";

export function editorWorkspaceModeForLayout(
  preferences: EditorLayoutPreferences,
): EditorWorkspaceMode {
  return preferences.authorCollapsed || preferences.previewFocused ? "preview" : "author";
}

export function clampEditorSplitRatio(value: number): number {
  return Math.min(72, Math.max(28, Math.round(value)));
}

export function readEditorLayoutPreferences(): EditorLayoutPreferences {
  if (typeof window === "undefined") return DEFAULT_EDITOR_LAYOUT;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY) ?? "null",
    ) as Partial<EditorLayoutPreferences> | null;
    if (
      !value ||
      typeof value.splitRatio !== "number" ||
      typeof value.authorCollapsed !== "boolean" ||
      typeof value.previewFocused !== "boolean"
    ) {
      return DEFAULT_EDITOR_LAYOUT;
    }
    return {
      splitRatio: clampEditorSplitRatio(value.splitRatio),
      authorCollapsed: value.authorCollapsed,
      previewFocused: value.previewFocused,
    };
  } catch {
    return DEFAULT_EDITOR_LAYOUT;
  }
}

export function writeEditorLayoutPreferences(preferences: EditorLayoutPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    EDITOR_LAYOUT_STORAGE_KEY,
    JSON.stringify({ ...preferences, splitRatio: clampEditorSplitRatio(preferences.splitRatio) }),
  );
}

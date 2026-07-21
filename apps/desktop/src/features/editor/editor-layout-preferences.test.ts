import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_LAYOUT,
  EDITOR_LAYOUT_STORAGE_KEY,
  editorWorkspaceModeForLayout,
  readEditorLayoutPreferences,
  writeEditorLayoutPreferences,
} from "./editor-layout-preferences";

describe("editor layout preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("falls back for invalid persisted values", () => {
    window.localStorage.setItem(EDITOR_LAYOUT_STORAGE_KEY, "{not-json");
    expect(readEditorLayoutPreferences()).toEqual(DEFAULT_EDITOR_LAYOUT);
  });

  it("persists a clamped split ratio", () => {
    writeEditorLayoutPreferences({ splitRatio: 99, authorCollapsed: true, previewFocused: false });
    expect(readEditorLayoutPreferences()).toEqual({
      splitRatio: 72,
      authorCollapsed: true,
      previewFocused: false,
    });
  });

  it("opens in Preview whenever the persisted Author panel is hidden", () => {
    expect(editorWorkspaceModeForLayout(DEFAULT_EDITOR_LAYOUT)).toBe("author");
    expect(editorWorkspaceModeForLayout({ ...DEFAULT_EDITOR_LAYOUT, authorCollapsed: true })).toBe(
      "preview",
    );
    expect(editorWorkspaceModeForLayout({ ...DEFAULT_EDITOR_LAYOUT, previewFocused: true })).toBe(
      "preview",
    );
  });
});

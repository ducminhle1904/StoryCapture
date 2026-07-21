import { describe, expect, it } from "vitest";

import {
  deriveProjectStagePresentation,
  type ProjectWorkflowSnapshot,
  projectStagePath,
} from "./project-stage";

const READY: ProjectWorkflowSnapshot = {
  storyValid: true,
  previewState: "complete",
  hasValidRecording: true,
  editState: "ready",
  exportReady: true,
};

describe("project stage workflow", () => {
  it("keeps public route paths stable", () => {
    expect(projectStagePath("p1", "author")).toBe("/editor/p1");
    expect(projectStagePath("p1", "preview")).toBe("/editor/p1");
    expect(projectStagePath("p1", "record")).toBe("/recorder/p1");
    expect(projectStagePath("p1", "edit")).toBe("/post-production/p1");
    expect(projectStagePath("p1", "export")).toBe("/post-production/p1");
  });

  it("hard-gates record, edit, and export at their real prerequisites", () => {
    const snapshot: ProjectWorkflowSnapshot = {
      ...READY,
      storyValid: false,
      hasValidRecording: false,
      editState: "unavailable",
      exportReady: false,
    };
    expect(deriveProjectStagePresentation("record", "author", snapshot).state).toBe("blocked");
    expect(deriveProjectStagePresentation("edit", "author", snapshot).state).toBe("blocked");
    expect(deriveProjectStagePresentation("export", "author", snapshot).state).toBe("blocked");
  });

  it("marks failed preview and guided review as needing attention", () => {
    expect(
      deriveProjectStagePresentation("preview", "author", {
        ...READY,
        previewState: "failed",
      }).state,
    ).toBe("needs_attention");
    expect(
      deriveProjectStagePresentation("edit", "author", {
        ...READY,
        editState: "review",
      }).state,
    ).toBe("needs_attention");
  });
});

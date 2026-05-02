import { describe, expect, it } from "vitest";

import {
  buildWorkflowState,
  buildWorkflowStory,
  createWorkflowInputs,
  WORKFLOW_CATALOG,
} from "./workflow-catalog";

describe("workflow catalog", () => {
  it("defines the eight guided video workflows", () => {
    expect(WORKFLOW_CATALOG.map((entry) => entry.id)).toEqual([
      "product_demo",
      "tutorial",
      "feature_launch",
      "sales_marketing",
      "support",
      "internal_training",
      "bug_reproduction",
      "documentation",
    ]);
  });

  it("builds workflow metadata and parseable-looking starter sources", () => {
    for (const entry of WORKFLOW_CATALOG) {
      const inputs = createWorkflowInputs(entry);
      inputs.target_url = "https://demo.example.com";
      const state = buildWorkflowState(entry);
      const source = buildWorkflowStory(entry, `${entry.title} Story`, inputs);

      expect(state.type).toBe(entry.id);
      expect(state.steps).toHaveLength(entry.roadmapSteps.length);
      expect(state.steps.every((step) => step.status === "drafted")).toBe(true);
      expect(source).toContain('app: "https://demo.example.com"');
      expect(source).toContain("viewport: desktop");
      expect(source).toContain("pause");
      expect(source).not.toMatch(/\bwait for\b|\bassert visible\b|\bnavigate back\b/);
    }
  });
});

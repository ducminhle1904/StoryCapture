import { describe, expect, it } from "vitest";

import { formatWorkflowType, summarizeWorkflowState, workflowSteps } from "./workflows";

describe("web workflow helpers", () => {
  it("formats workflow enum values", () => {
    expect(formatWorkflowType("PRODUCT_DEMO")).toBe("Product Demo");
    expect(formatWorkflowType("BUG_REPRODUCTION")).toBe("Bug Reproduction");
    expect(formatWorkflowType(null)).toBeNull();
  });

  it("summarizes workflow step status counts", () => {
    const state = {
      version: 1,
      type: "product_demo",
      steps: [
        { id: "a", title: "A", status: "drafted" },
        { id: "b", title: "B", status: "drafted" },
        { id: "c", title: "C", status: "recorded" },
      ],
    };

    expect(summarizeWorkflowState(state)).toEqual({ drafted: 2, recorded: 1 });
    expect(workflowSteps(state)).toHaveLength(3);
  });
});

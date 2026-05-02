import { describe, expect, it } from "vitest";

import { workflowTypeToWeb } from "./projects";

describe("project workflow sync helpers", () => {
  it("maps local workflow types to web enum values", () => {
    expect(workflowTypeToWeb("product_demo")).toBe("PRODUCT_DEMO");
    expect(workflowTypeToWeb("feature_launch")).toBe("FEATURE_LAUNCH");
    expect(workflowTypeToWeb("bug_reproduction")).toBe("BUG_REPRODUCTION");
    expect(workflowTypeToWeb("freestyle")).toBe("FREESTYLE");
  });
});

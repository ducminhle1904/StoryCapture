import { describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "../init";

import { templateRouter } from "./template";

describe("template router workflow metadata", () => {
  it("filters templates by workflow type", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "template-1",
        name: "Product Demo Roadmap",
        description: "Demo",
        category: "SAAS_ONBOARDING",
        workflowType: "PRODUCT_DEMO",
        bestFor: "Homepage",
        durationTarget: "90-150 sec",
        polishPreset: "dynamic",
        requiredInputs: ["target_url"],
        forkCount: 0,
        thumbnailUrl: null,
      },
    ]);
    const caller = createCallerFactory(templateRouter)({
      prisma: { template: { findMany } },
      session: null,
      user: null,
      headers: new Headers(),
    } as never);

    const result = await caller.listByCategory({ workflowType: "PRODUCT_DEMO" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowType: "PRODUCT_DEMO" },
      }),
    );
    expect(result.templates[0]?.workflowType).toBe("PRODUCT_DEMO");
  });

  it("returns workflow metadata when forking a template", async () => {
    const caller = createCallerFactory(templateRouter)({
      prisma: {
        template: {
          findUnique: vi.fn().mockResolvedValue({
            id: "template-1",
            name: "Product Demo Roadmap",
            storySource: "story",
            workflowType: "PRODUCT_DEMO",
            workflowState: { version: 1, type: "product_demo", steps: [] },
            requiredInputs: ["target_url"],
            polishPreset: "dynamic",
          }),
          update: vi.fn().mockResolvedValue({}),
        },
      },
      session: { user: { id: "user-1" } },
      user: { id: "user-1" },
      headers: new Headers(),
    } as never);

    const result = await caller.fork({ templateId: "template-1" });

    expect(result.workflowType).toBe("PRODUCT_DEMO");
    expect(result.workflowState).toEqual({ version: 1, type: "product_demo", steps: [] });
    expect(result.requiredInputs).toEqual(["target_url"]);
    expect(result.polishPreset).toBe("dynamic");
  });
});

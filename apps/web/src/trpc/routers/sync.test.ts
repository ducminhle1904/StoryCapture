import { describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "../init";

import { syncRouter } from "./sync";

describe("sync router workflow metadata", () => {
  it("persists workflow metadata on pushMetadata", async () => {
    const upsert = vi.fn().mockResolvedValue({
      recordingStatus: "idle",
      workflowType: "PRODUCT_DEMO",
      workflowState: { version: 1, type: "product_demo", steps: [] },
      lastSyncedAt: new Date("2026-05-02T00:00:00.000Z"),
    });
    const caller = createCallerFactory(syncRouter)({
      prisma: {
        workspaceMember: {
          findUnique: vi.fn().mockResolvedValue({ role: "OWNER" }),
        },
        syncedProject: { upsert },
      },
      session: { user: { id: "user-1" } },
      user: { id: "user-1" },
      headers: new Headers(),
    } as never);

    await caller.pushMetadata({
      desktopId: "desktop-1",
      workspaceId: "workspace-1",
      projectName: "Launch Demo",
      workflowType: "PRODUCT_DEMO",
      workflowState: { version: 1, type: "product_demo", steps: [] },
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workflowType: "PRODUCT_DEMO",
          workflowState: { version: 1, type: "product_demo", steps: [] },
        }),
        update: expect.objectContaining({
          workflowType: "PRODUCT_DEMO",
          workflowState: { version: 1, type: "product_demo", steps: [] },
        }),
      }),
    );
  });

  it("returns workflow metadata from listProjects", async () => {
    const caller = createCallerFactory(syncRouter)({
      prisma: {
        workspaceMember: {
          findUnique: vi.fn().mockResolvedValue({ role: "OWNER" }),
        },
        syncedProject: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "synced-1",
              desktopId: "desktop-1",
              projectName: "Launch Demo",
              storySource: "story",
              workflowType: "PRODUCT_DEMO",
              workflowState: { version: 1, type: "product_demo", steps: [] },
              recordingStatus: "idle",
              lastSyncedAt: new Date("2026-05-02T00:00:00.000Z"),
            },
          ]),
        },
      },
      session: { user: { id: "user-1" } },
      user: { id: "user-1" },
      headers: new Headers(),
    } as never);

    const result = await caller.listProjects({ workspaceId: "workspace-1" });

    expect(result[0]?.workflowType).toBe("PRODUCT_DEMO");
    expect(result[0]?.workflowState).toEqual({ version: 1, type: "product_demo", steps: [] });
  });
});

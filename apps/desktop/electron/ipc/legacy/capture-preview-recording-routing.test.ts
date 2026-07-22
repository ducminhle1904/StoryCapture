import type { StartRecordingArgs } from "@storycapture/shared-types";
import { describe, expect, it, vi } from "vitest";

import { routeSpecializedRecordingStart } from "./recording-start-routing";

const developmentArgs: StartRecordingArgs = {
  project_folder: "/project",
  target: { kind: "author_preview", stream_id: "preview-1" },
  width: 960,
  height: 540,
  fps: 60,
  contract_version: 3,
  intent: "development",
  delivery_policy: "development",
};

describe("recording start routing", () => {
  it("routes development policy into the V3 lifecycle before Standard allocation", async () => {
    const startStrictBrowser = vi.fn(async () => ({ id: "v3-session" }));
    const authorPreviewUrl = vi.fn(() => "http://127.0.0.1:1420/preview");

    const routed = await routeSpecializedRecordingStart(
      developmentArgs,
      {},
      {} as never,
      { startStrictBrowser, authorPreviewUrl },
    );

    expect(routed).toEqual({ handled: true, result: { id: "v3-session" } });
    expect(authorPreviewUrl).toHaveBeenCalledWith("preview-1");
    expect(startStrictBrowser).toHaveBeenCalledWith(
      developmentArgs,
      {},
      expect.anything(),
      "http://127.0.0.1:1420/preview",
    );
  });

  it("leaves best-effort requests for the Standard path", async () => {
    const startStrictBrowser = vi.fn();
    const routed = await routeSpecializedRecordingStart(
      { ...developmentArgs, contract_version: 2, intent: undefined, delivery_policy: "best_effort" },
      {},
      {} as never,
      { startStrictBrowser, authorPreviewUrl: vi.fn() },
    );

    expect(routed).toEqual({ handled: false });
    expect(startStrictBrowser).not.toHaveBeenCalled();
  });
});

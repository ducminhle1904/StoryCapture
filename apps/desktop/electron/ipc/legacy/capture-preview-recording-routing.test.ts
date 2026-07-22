import type { StartRecordingArgs } from "@storycapture/shared-types";
import { describe, expect, it, vi } from "vitest";

import { routeSpecializedRecordingStart } from "./recording-start-routing";

const strictLocalArgs: StartRecordingArgs = {
  project_folder: "/project",
  target: { kind: "author_preview", stream_id: "preview-1" },
  width: 960,
  height: 540,
  fps: 60,
  contract_version: 3,
  enforcement_mode: "strict",
  certification_mode: "local",
  delivery_policy: "strict",
};

describe("recording start routing", () => {
  it("routes Strict Local policy into the V3 lifecycle before Standard allocation", async () => {
    const startStrictBrowser = vi.fn(async () => ({ id: "v3-session" }));
    const authorPreviewUrl = vi.fn(() => "http://127.0.0.1:1420/preview");

    const routed = await routeSpecializedRecordingStart(
      strictLocalArgs,
      {},
      {} as never,
      { startStrictBrowser, authorPreviewUrl },
    );

    expect(routed).toEqual({ handled: true, result: { id: "v3-session" } });
    expect(authorPreviewUrl).toHaveBeenCalledWith("preview-1");
    expect(startStrictBrowser).toHaveBeenCalledWith(
      strictLocalArgs,
      {},
      expect.anything(),
      "http://127.0.0.1:1420/preview",
    );
  });

  it("leaves best-effort requests for the Standard path", async () => {
    const startStrictBrowser = vi.fn();
    const routed = await routeSpecializedRecordingStart(
      {
        ...strictLocalArgs,
        contract_version: 2,
        enforcement_mode: undefined,
        certification_mode: undefined,
        delivery_policy: "best_effort",
      },
      {},
      {} as never,
      { startStrictBrowser, authorPreviewUrl: vi.fn() },
    );

    expect(routed).toEqual({ handled: false });
    expect(startStrictBrowser).not.toHaveBeenCalled();
  });
});

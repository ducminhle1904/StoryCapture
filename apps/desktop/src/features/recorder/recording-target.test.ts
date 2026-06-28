import { describe, expect, it } from "vitest";

import { authorPreviewRecordingPlan } from "./recording-target";

describe("recording target helpers", () => {
  it("selects the internal author-preview target for browser recordings", () => {
    expect(authorPreviewRecordingPlan("author-1", { width: 1920, height: 1080 })).toEqual({
      target: {
        kind: "author_preview",
        stream_id: "author-1",
      },
      width: 1920,
      height: 1080,
      frameCrop: null,
    });
  });
});

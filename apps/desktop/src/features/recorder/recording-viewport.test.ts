import { describe, expect, it } from "vitest";

import { storyAppUrlForRecording, storyViewportSize } from "./recording-viewport";

describe("recording viewport helpers", () => {
  it("preserves numeric story viewport metadata", () => {
    const source = `
      story "Demo" {
        meta {
          app: "https://app.example.test"
          viewport: 1920x1080
        }
      }
    `;

    expect(storyViewportSize(source)).toEqual({ width: 1920, height: 1080 });
    expect(storyAppUrlForRecording(source)).toBe("https://app.example.test");
  });

  it("uses existing named editor viewport presets", () => {
    expect(storyViewportSize("meta { viewport: tablet }")).toEqual({ width: 768, height: 1024 });
  });
});

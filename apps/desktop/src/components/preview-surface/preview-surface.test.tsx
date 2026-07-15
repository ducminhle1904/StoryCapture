import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreviewSurface } from "./preview-surface";

const { previewPlayerSpy } = vi.hoisted(() => ({
  previewPlayerSpy: vi.fn(),
}));

vi.mock("@/features/post-production/preview/preview-player", () => ({
  PreviewPlayer: (props: unknown) => {
    previewPlayerSpy(props);
    return <div data-testid="preview-player" />;
  },
}));

describe("PreviewSurface", () => {
  it("cuts the production post-production surface over to the canonical canvas", () => {
    render(<PreviewSurface mode="post-production" storyId="story-1" videoSrc="/tmp/source.mp4" />);

    expect(previewPlayerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: "story-1",
        videoSrc: "/tmp/source.mp4",
        outputMode: "composited-canvas",
      }),
    );
  });
});

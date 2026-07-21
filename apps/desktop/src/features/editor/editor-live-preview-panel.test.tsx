import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EditorLivePreviewPanel } from "./editor-live-preview-panel";

vi.mock("@/features/editor/PreviewLocationBar", () => ({
  PreviewLocationBar: () => null,
}));

vi.mock("@/features/editor/PreviewPickerButton", () => ({
  PickingBanner: () => null,
  PreviewPickerButton: () => null,
}));

vi.mock("@/features/recorder/live-preview", () => ({
  LivePreview: () => <div data-testid="live-preview" />,
}));

const baseProps = {
  appUrl: null,
  appUrlValid: false,
  authorDriverVariant: "idle",
  latestRecording: null,
  previewNav: { url: null, canGoBack: false, canGoForward: false },
  previewStatus: "idle" as const,
  previewViewport: "desktop" as const,
  simulatorActiveFrame: null,
  simulatorRunState: "idle",
  streamId: null,
  onViewportChange: vi.fn(),
};

describe("EditorLivePreviewPanel", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterAll(() => vi.unstubAllGlobals());

  it("offers a direct way to restore Author when its panel is hidden", () => {
    const onShowAuthor = vi.fn();
    render(<EditorLivePreviewPanel {...baseProps} authorHidden onShowAuthor={onShowAuthor} />);

    fireEvent.click(screen.getByRole("button", { name: "Show Author" }));
    expect(onShowAuthor).toHaveBeenCalledOnce();
  });

  it("does not show the restore action while Author is visible", () => {
    render(<EditorLivePreviewPanel {...baseProps} authorHidden={false} onShowAuthor={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show Author" })).not.toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as Parameters<typeof invokeMock>)),
}));

vi.mock("@/lib/log", () => ({
  frontendLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PreviewLocationBar } from "./PreviewLocationBar";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const baseProps = {
  streamId: "stream-1",
  url: "https://example.com/path",
  canGoBack: true,
  canGoForward: true,
  disabled: false,
};

describe("<PreviewLocationBar />", () => {
  it("renders three buttons + the URL display", () => {
    render(<PreviewLocationBar {...baseProps} />);
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(screen.getByLabelText("Forward")).toBeInTheDocument();
    expect(screen.getByLabelText("Reload")).toBeInTheDocument();
    const display = screen.getByTestId("preview-url-display");
    expect(display).toHaveTextContent("https://example.com/path");
    expect(display.getAttribute("title")).toBe("https://example.com/path");
    expect(display.getAttribute("aria-readonly")).toBe("true");
  });

  it("placeholder when url is null", () => {
    render(<PreviewLocationBar {...baseProps} url={null} />);
    const display = screen.getByTestId("preview-url-display");
    expect(display).toHaveTextContent("—");
    expect(display.getAttribute("title")).toBe("");
  });

  it("disables Back/Forward when canGo* is false", () => {
    render(
      <PreviewLocationBar
        {...baseProps}
        canGoBack={false}
        canGoForward={false}
      />,
    );
    expect(screen.getByLabelText("Back")).toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
    expect(screen.getByLabelText("Reload")).not.toBeDisabled();
  });

  it("disables all 3 buttons when disabled prop is true", () => {
    render(<PreviewLocationBar {...baseProps} disabled />);
    expect(screen.getByLabelText("Back")).toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
    expect(screen.getByLabelText("Reload")).toBeDisabled();
  });

  it("disables all 3 buttons when streamId is null", () => {
    render(<PreviewLocationBar {...baseProps} streamId={null} />);
    expect(screen.getByLabelText("Back")).toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
    expect(screen.getByLabelText("Reload")).toBeDisabled();
  });

  it("Back click invokes author_preview_back", () => {
    render(<PreviewLocationBar {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(invokeMock).toHaveBeenCalledWith("author_preview_back", {
      streamId: "stream-1",
    });
  });

  it("Forward click invokes author_preview_forward", () => {
    render(<PreviewLocationBar {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Forward"));
    expect(invokeMock).toHaveBeenCalledWith("author_preview_forward", {
      streamId: "stream-1",
    });
  });

  it("Reload click invokes author_preview_reload", () => {
    render(<PreviewLocationBar {...baseProps} />);
    fireEvent.click(screen.getByLabelText("Reload"));
    expect(invokeMock).toHaveBeenCalledWith("author_preview_reload", {
      streamId: "stream-1",
    });
  });

  it("URL display reflects prop changes", () => {
    const { rerender } = render(<PreviewLocationBar {...baseProps} />);
    expect(screen.getByTestId("preview-url-display")).toHaveTextContent(
      "https://example.com/path",
    );
    rerender(
      <PreviewLocationBar {...baseProps} url="https://other.example.org/" />,
    );
    expect(screen.getByTestId("preview-url-display")).toHaveTextContent(
      "https://other.example.org/",
    );
  });
});

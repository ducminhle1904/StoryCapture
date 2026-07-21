import type { ToastOptions } from "@astryxdesign/core/Toast";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => showToast,
}));

vi.mock("@astryxdesign/core/Button", () => ({
  Button: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock("@astryxdesign/core/Text", () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { NotificationPresenter, notifications } from "./notifications";

describe("notifications", () => {
  beforeEach(() => {
    showToast.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("preserves warning semantics and dismisses after an action", () => {
    const dismiss = vi.fn();
    const action = vi.fn();
    showToast.mockReturnValue(dismiss);
    render(<NotificationPresenter />);

    act(() => {
      notifications.warning("Story changed on disk", {
        action: { label: "Reload", onClick: action },
      });
    });

    const options = showToast.mock.calls[0]?.[0] as ToastOptions;
    expect(options.type).toBe("info");
    render(
      <>
        {options.body}
        {options.endContent}
      </>,
    );

    expect(screen.getByText("Warning:")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(action).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

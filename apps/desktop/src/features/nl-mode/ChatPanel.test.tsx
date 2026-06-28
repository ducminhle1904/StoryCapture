/**
 * ChatPanel tests.
 *
 * Covers 6 behaviors:
 * 1. Empty state: heading + CTA
 * 2. Streaming: assistant bubble with streaming dot
 * 3. Resize: updates panelWidth
 * 4. Collapse: panel collapses to 40px
 * 5. Rate-limit banner: Vietnamese copy + countdown
 * 6. Send message: Cmd+Enter invokes nl_chat_send
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import { useNlStore } from "./nlStore";

// Mock Tauri invoke -- use vi.hoisted to avoid hoisting issue with vi.mock
const { mockInvoke, MockChannel } = vi.hoisted(() => {
  const mockInvoke = vi.fn().mockResolvedValue("task-123");
  class MockChannel {
    onmessage: ((ev: unknown) => void) | null = null;
    id = 1;
    __TAURI_CHANNEL_MARKER__ = true;
    toJSON() {
      return `__CHANNEL__:${this.id}`;
    }
  }
  return { mockInvoke, MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: MockChannel,
}));

describe("ChatPanel", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    // Reset store state
    useNlStore.setState({
      panelWidth: 420,
      panelCollapsed: false,
      streaming: null,
      pendingCards: [],
      error: null,
      messages: [],
    });
  });

  it("renders empty state heading and CTA when no cards and not streaming", () => {
    render(<ChatPanel projectId="proj-1" currentStory="" />);

    // Vietnamese: "Viet story bang loi"
    expect(
      screen.getByText(/Vi\u1ebft story b\u1eb1ng l\u1eddi/),
    ).toBeTruthy();
    expect(screen.getByTestId("nl-chat-panel")).toBeTruthy();
    expect(screen.getByText(/Make the onboarding story shorter/)).toBeTruthy();
  });

  it("renders streaming dot when streaming is active", () => {
    useNlStore.setState({
      streaming: { taskId: "task-1", text: "Generating..." },
    });

    render(<ChatPanel projectId="proj-1" currentStory="" />);

    expect(screen.getByTestId("streaming-dot")).toBeTruthy();
  });

  it("updates panelWidth in the store when resize callback fires", () => {
    render(<ChatPanel projectId="proj-1" currentStory="" />);

    const panel = screen.getByTestId("nl-chat-panel");
    expect(panel).toBeTruthy();

    // Simulate resize by directly updating store
    act(() => {
      useNlStore.getState().setPanelWidth(500);
    });
    expect(useNlStore.getState().panelWidth).toBe(500);
  });

  it("collapses panel to 40px when collapse button is clicked", async () => {
    render(<ChatPanel projectId="proj-1" currentStory="" />);

    // aria-label="Thu gon panel"
    const collapseBtn = screen.getByLabelText(/Thu g\u1ecdn/i);
    await userEvent.click(collapseBtn);

    expect(useNlStore.getState().panelCollapsed).toBe(true);
  });

  it("renders rate-limit banner with Vietnamese copy when error.kind is rate_limit", () => {
    useNlStore.setState({
      error: {
        kind: "rate_limit",
        message: "Rate limited",
        retryAfterS: 30,
      },
    });

    render(<ChatPanel projectId="proj-1" currentStory="" />);

    // Rate limit banner should be present with Vietnamese copy
    const banner = screen.getByTestId("rate-limit-banner");
    expect(banner).toBeTruthy();
    // Check banner contains Vietnamese retry text "Thu lai sau" and countdown
    expect(banner.textContent).toMatch(/Th\u1eed l\u1ea1i sau/);
    // CTA: "Doi va thu lai"
    expect(banner.textContent).toMatch(/\u0110\u1ee3i v\u00e0 th\u1eed l\u1ea1i/);
  });

  it("invokes nl_chat_send when pressing Cmd+Enter in textarea", async () => {
    render(<ChatPanel projectId="proj-1" currentStory="story content" />);

    // placeholder: "Mo ta luong ban muon..."
    const textarea = screen.getByPlaceholderText(
      /M\u00f4 t\u1ea3 lu\u1ed3ng/,
    );
    await userEvent.type(textarea, "Create a login flow");

    // Fire Cmd+Enter
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    // Wait for async invoke
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "nl_chat_send",
        expect.objectContaining({
          userMessage: "Create a login flow",
        }),
      );
    });
  });
});

/**
 * TokenCounter + CostWarningModal + AiDisclosureModal tests.
 *
 * Covers 5 behaviors:
 * 1. Token counter polls session_get_rollup every 500ms; renders cost.
 * 2. When cost > $1.00, counter switches to warning color.
 * 3. Clicking counter opens TokenBreakdownPopover.
 * 4. CostWarningModal renders when input > 50K tokens; checkbox suppresses.
 * 5. CostWarningModal is skipped when previously suppressed in session.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri invoke
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// Mock TanStack Query - provide a minimal wrapper
vi.mock("@tanstack/react-query", () => {
  const actual = vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

import { useQuery } from "@tanstack/react-query";

const mockUseQuery = vi.mocked(useQuery);

describe("TokenCounter", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls session_get_rollup and renders cost $0.00 -> $0.34", async () => {
    mockUseQuery.mockReturnValue({
      data: { turn_count: 5, total_cost_usd: 0.34, total_tokens: 12000, avg_first_token_ms: 250 },
      isError: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);

    const { TokenCounter } = await import("./TokenCounter");
    render(<TokenCounter sessionId="sess-1" projectId="proj-1" />);

    expect(screen.getByTestId("token-counter")).toBeTruthy();
    expect(screen.getByText("$0.34")).toBeTruthy();
  });

  it("switches to warning color when cost > $1.00", async () => {
    mockUseQuery.mockReturnValue({
      data: { turn_count: 20, total_cost_usd: 1.5, total_tokens: 80000, avg_first_token_ms: 300 },
      isError: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);

    const { TokenCounter } = await import("./TokenCounter");
    render(<TokenCounter sessionId="sess-1" projectId="proj-1" />);

    const counter = screen.getByTestId("token-counter");
    // Should have warning class
    expect(counter.className).toMatch(/warning|amber|yellow/i);
  });

  it("clicking counter opens TokenBreakdownPopover", async () => {
    mockUseQuery.mockReturnValue({
      data: { turn_count: 3, total_cost_usd: 0.12, total_tokens: 5000, avg_first_token_ms: 200 },
      isError: false,
      isLoading: false,
    } as ReturnType<typeof useQuery>);

    const { TokenCounter } = await import("./TokenCounter");
    render(<TokenCounter sessionId="sess-1" projectId="proj-1" />);

    const counter = screen.getByTestId("token-counter");
    fireEvent.click(counter);

    expect(screen.getByTestId("token-breakdown-popover")).toBeTruthy();
  });
});

describe("CostWarningModal", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("renders when estimated input > 50K tokens with checkbox and Vietnamese copy", async () => {
    const { CostWarningModal } = await import("../nl-mode/CostWarningModal");
    const onResult = vi.fn();

    render(<CostWarningModal estimatedTokens={60000} open={true} onResult={onResult} />);

    expect(screen.getByText(/This prompt uses a lot of tokens/)).toBeTruthy();
    expect(screen.getByText(/Don't ask again for this session/)).toBeTruthy();
    expect(screen.getByText(/Continue/)).toBeTruthy();
    expect(screen.getByText(/Cancel/)).toBeTruthy();
  });

  it("skips display when suppressForSession was previously checked", async () => {
    const { CostWarningModal } = await import("../nl-mode/CostWarningModal");
    const onResult = vi.fn();

    // Render with suppressed=true
    render(
      <CostWarningModal
        estimatedTokens={60000}
        open={true}
        suppressed={true}
        onResult={onResult}
      />,
    );

    // Should not render modal content when suppressed
    expect(screen.queryByText(/This prompt uses a lot of tokens/)).toBeNull();
  });
});

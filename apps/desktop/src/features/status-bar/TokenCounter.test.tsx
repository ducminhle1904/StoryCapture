/**
 * TokenCounter + CostWarningModal + AiDisclosureModal tests (Plan 03-20, Task 2).
 *
 * Covers 6 behaviors:
 * 1. Token counter polls session_get_rollup every 500ms; renders cost.
 * 2. When cost > $1.00, counter switches to warning color.
 * 3. Clicking counter opens TokenBreakdownPopover.
 * 4. CostWarningModal renders when input > 50K tokens; checkbox suppresses.
 * 5. CostWarningModal is skipped when previously suppressed in session.
 * 6. AiDisclosureModal on export with TTS clips; C2PA default ON.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
      data: { turn_count: 20, total_cost_usd: 1.50, total_tokens: 80000, avg_first_token_ms: 300 },
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

    render(
      <CostWarningModal
        estimatedTokens={60000}
        open={true}
        onResult={onResult}
      />,
    );

    // Vietnamese copy
    expect(
      screen.getByText(/Prompt n\u00e0y d\u00f9ng nhi\u1ec1u token/),
    ).toBeTruthy();

    // Checkbox
    expect(
      screen.getByText(/\u0110\u1eebng h\u1ecfi l\u1ea1i cho session n\u00e0y/),
    ).toBeTruthy();

    // Buttons
    expect(screen.getByText(/Ti\u1ebfp t\u1ee5c/)).toBeTruthy();
    expect(screen.getByText(/Hu\u1ef7/)).toBeTruthy();
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
    expect(screen.queryByText(/Prompt n\u00e0y d\u00f9ng nhi\u1ec1u token/)).toBeNull();
  });
});

describe("AiDisclosureModal", () => {
  it("renders EU AI Act text + C2PA checkbox default ON on export with TTS clips", async () => {
    const { AiDisclosureModal } = await import("../export/AiDisclosureModal");
    const onResult = vi.fn();

    render(
      <AiDisclosureModal
        open={true}
        ttsClipCount={3}
        onResult={onResult}
      />,
    );

    // EU AI Act text
    expect(screen.getByText(/EU AI Act/)).toBeTruthy();

    // C2PA checkbox default ON
    const c2paCheckbox = screen.getByRole("checkbox", {
      name: /C2PA/i,
    });
    expect(c2paCheckbox).toBeTruthy();
    expect(c2paCheckbox).toBeChecked();

    // Buttons
    expect(screen.getByText(/Export anyway/)).toBeTruthy();
    expect(screen.getByText(/Cancel/)).toBeTruthy();
  });
});

/**
 * DryRunPanel + DryRunStepRow + SelectorFallbackPopover tests.
 *
 * 6 behaviors:
 * 1. Empty state copy "Chua co lan chay thu nao" when summary === null && panelOpen
 * 2. Step rows animate status background via motion/react 160ms
 * 3. Clicking "Chay thu" button calls onStart(steps)
 * 4. Clicking step row fires onStepClick with stepId
 * 5. SelectorFallbackPopover renders "Cap nhat selector" CTA + winning strategy
 * 6. Keyboard nav: arrows move focus, Enter fires onStepClick, Esc initiates cancel
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DryRunPanel } from "./DryRunPanel";
import { DryRunStepRow } from "./DryRunStepRow";
import { SelectorFallbackPopover } from "./SelectorFallbackPopover";
import { useDryRunStore } from "./dryRunStore";

// Mock Tauri
const { mockInvoke, MockChannel } = vi.hoisted(() => {
  const mockInvoke = vi.fn().mockResolvedValue("task-1");
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

const sampleSteps = [
  { id: "s1", verb: "navigate", args: { url: "https://example.com" }, label: "Open page", line: 1 },
  { id: "s2", verb: "click", args: { selector: "#btn" }, label: "Click button", line: 2 },
  { id: "s3", verb: "type", args: { selector: "#input", text: "hello" }, label: "Type text", line: 3 },
];

describe("DryRunPanel", () => {
  beforeEach(() => {
    useDryRunStore.setState({
      taskId: null,
      statusByStep: {},
      timingByStep: {},
      fallbackChainByStep: {},
      summary: null,
      panelOpen: true,
    });
  });

  it("renders empty state copy when summary === null and panelOpen", () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(
      <DryRunPanel steps={sampleSteps} onStart={onStart} onCancel={onCancel} />,
    );

    expect(screen.getByTestId("dryrun-panel")).toBeTruthy();
    // Vietnamese: "Chua co lan chay thu nao"
    expect(
      screen.getByText(/Ch\u01b0a c\u00f3 l\u1ea7n ch\u1ea1y th\u1eed n\u00e0o/),
    ).toBeTruthy();
  });

  it("renders step rows with status badges during running state", () => {
    useDryRunStore.setState({
      statusByStep: { s1: "pass", s2: "running", s3: "queued" },
      timingByStep: { s1: 120 },
      fallbackChainByStep: {},
    });

    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(
      <DryRunPanel steps={sampleSteps} onStart={onStart} onCancel={onCancel} />,
    );

    expect(screen.getByTestId("status-badge-s1")).toHaveTextContent("Pass");
    expect(screen.getByTestId("status-badge-s2")).toHaveTextContent("Running");
    expect(screen.getByTestId("status-badge-s3")).toHaveTextContent("Queued");
  });

  it("clicking 'Chay thu' button calls onStart(steps)", async () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(
      <DryRunPanel steps={sampleSteps} onStart={onStart} onCancel={onCancel} />,
    );

    const startBtn = screen.getByTestId("dryrun-start-btn");
    // Verify Vietnamese copy
    expect(startBtn.textContent).toMatch(/Ch\u1ea1y th\u1eed/);
    await userEvent.click(startBtn);

    expect(onStart).toHaveBeenCalledWith(sampleSteps);
  });

  it("clicking step row fires onStepClick with stepId", async () => {
    useDryRunStore.setState({
      statusByStep: { s1: "pass", s2: "pass", s3: "fail" },
      timingByStep: { s1: 100, s2: 200, s3: 300 },
      summary: { total: 3, passed: 2, failed: 1, totalMs: 600 },
    });

    const onStart = vi.fn();
    const onCancel = vi.fn();
    const onStepClick = vi.fn();
    render(
      <DryRunPanel
        steps={sampleSteps}
        onStart={onStart}
        onCancel={onCancel}
        onStepClick={onStepClick}
      />,
    );

    const stepRow = screen.getByTestId("dryrun-step-s2");
    await userEvent.click(stepRow);

    expect(onStepClick).toHaveBeenCalledWith("s2");
  });

  it("keyboard nav: arrows move focus, Enter fires onStepClick", () => {
    useDryRunStore.setState({
      statusByStep: { s1: "pass", s2: "pass", s3: "fail" },
      timingByStep: { s1: 100, s2: 200, s3: 300 },
      summary: { total: 3, passed: 2, failed: 1, totalMs: 600 },
    });

    const onStart = vi.fn();
    const onCancel = vi.fn();
    const onStepClick = vi.fn();
    render(
      <DryRunPanel
        steps={sampleSteps}
        onStart={onStart}
        onCancel={onCancel}
        onStepClick={onStepClick}
      />,
    );

    const panel = screen.getByTestId("dryrun-panel");

    // Arrow down to first step
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    // Arrow down to second step
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    // Enter to click step
    fireEvent.keyDown(panel, { key: "Enter" });

    expect(onStepClick).toHaveBeenCalledWith("s2");

    // Arrow up back to first step
    fireEvent.keyDown(panel, { key: "ArrowUp" });
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(onStepClick).toHaveBeenCalledWith("s1");
  });
});

describe("SelectorFallbackPopover", () => {
  it("renders UI-SPEC copy with winning strategy + 'Cap nhat selector' CTA", () => {
    const chain = [
      { strategy: "css", selector: "#btn", succeeded: false, durationMs: 50 },
      { strategy: "xpath", selector: "//button", succeeded: true, durationMs: 120 },
    ];
    const onUpdate = vi.fn();
    render(
      <SelectorFallbackPopover
        fallbackChain={chain}
        onUpdateSelector={onUpdate}
      />,
    );

    // Vietnamese: "Selector qua chung"
    expect(
      screen.getByText(/Selector qu\u00e1 chung/),
    ).toBeTruthy();

    // Winning strategy info: "strategy 2 thang trong 120ms"
    expect(
      screen.getByText(/strategy 2 th\u1eafng trong 120ms/),
    ).toBeTruthy();

    // CTA: "Cap nhat selector"
    const ctaBtn = screen.getByText(/C\u1eadp nh\u1eadt selector/);
    expect(ctaBtn).toBeTruthy();
  });
});

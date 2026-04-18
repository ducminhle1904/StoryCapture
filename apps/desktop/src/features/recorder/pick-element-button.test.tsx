/**
 * PickElementButton vitest with Tauri IPC mocks.
 *
 * THE FINAL GATE for PHASE-7.4 — proves end-to-end that the sidecar's
 * `result.emitted` field (07-03a wire contract) reaches the editor as
 * `editorController.insertAtCursor(emitted + "\n")`.
 *
 * 4 cases:
 *   1. Disabled when recorder.status is not "recording"/"paused"
 *   2. Happy path → mocked invoke("picker_start") returns
 *      { emitted: 'click button "Save"', ... } → editorController spy
 *      called with 'click button "Save"\n'
 *   3. Cancel path → mocked returns { cancelled: true, reason: "user-cancel" }
 *      → editorController spy NOT called
 *   4. Banner with role="status" appears after click and disappears after settle
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

// Mock sonner so toasts don't blow up jsdom.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

import { editorController } from "@/features/editor/controller";
import { useRecorderStore } from "@/state/recorder";

import { PickElementButton } from "./pick-element-button";

describe("PickElementButton", () => {
  let insertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    insertSpy = vi
      .spyOn(editorController, "insertAtCursor")
      .mockReturnValue({ ok: true, lineNumber: 1 });
    // Default: live session.
    useRecorderStore.setState({ status: "recording" });
  });

  afterEach(() => {
    clearMocks();
    insertSpy.mockRestore();
    useRecorderStore.setState({ status: "idle" });
  });

  it("is disabled when recorder.status is not live", () => {
    useRecorderStore.setState({ status: "idle" });
    render(<PickElementButton />);
    const button = screen.getByRole("button", { name: /pick element/i });
    expect(button).toBeDisabled();
  });

  it("happy path: emitted DSL is inserted at cursor with trailing newline (PHASE-7.4 gate)", async () => {
    // Sidecar wire contract (07-03a): success response shape.
    mockIPC((cmd) => {
      if (cmd === "picker_start") {
        return {
          json: JSON.stringify({
            emitted: 'click button "Save"',
            locator: { kind: "role", value: { role: "button", name: "Save" } },
            candidates: [],
          }),
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PickElementButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // FINAL GATE: prove the sidecar's `emitted` field flows to the editor
    // verbatim, with the appended newline per CONTEXT.md insertion semantics.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledWith('click button "Save"\n');
  });

  it("cancel path: cancelled response does NOT call editorController", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start") {
        return {
          json: JSON.stringify({ cancelled: true, reason: "user-cancel" }),
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PickElementButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("renders the aria-live banner while picking and removes it after settle", async () => {
    // Defer the resolution so the banner is observable mid-flight.
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    mockIPC((cmd) => {
      if (cmd === "picker_start") return pending;
      return undefined;
    });

    const user = userEvent.setup();
    render(<PickElementButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // Banner is mounted with role="status" + aria-live="polite".
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/PICKING/);
    expect(banner).toHaveAttribute("aria-live", "polite");

    // Resolve the picker; the banner should unmount.
    await act(async () => {
      resolve({
        json: JSON.stringify({
          emitted: 'click testid "save"',
          locator: { kind: "testid", value: "save" },
          candidates: [],
        }),
      });
      // Drain the microtask queue so the .then() in onClick runs.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  // hover-preview chip. Subscribed via the Tauri event
  // `picker_hover_preview`. The Rust forwarder task bridges the
  // broadcast channel → emit('picker_hover_preview', params).
  it("hover-preview chip renders with role+accessibleName from first event", async () => {
    // shouldMockEvents wires listen/emit so we can drive the subscriber
    // from the test without a real backend.
    mockIPC(
      (cmd) => {
        if (cmd === "picker_start") {
          // Keep the pick in flight; we assert on the chip mid-session.
          return new Promise(() => {});
        }
        return undefined;
      },
      { shouldMockEvents: true },
    );

    const user = userEvent.setup();
    render(<PickElementButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // Fire a hover-preview event — chip should render with role + name.
    await act(async () => {
      await emit("picker_hover_preview", {
        role: "button",
        accessibleName: "Save",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const chip = screen.getByRole("note");
      expect(chip).toHaveAttribute("aria-live", "polite");
      expect(chip).toHaveTextContent(/button "Save"/);
    });
  });

  it("hover-preview chip re-renders with testid on a second event", async () => {
    mockIPC(
      (cmd) => {
        if (cmd === "picker_start") return new Promise(() => {});
        return undefined;
      },
      { shouldMockEvents: true },
    );

    const user = userEvent.setup();
    render(<PickElementButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // First event: role+name.
    await act(async () => {
      await emit("picker_hover_preview", {
        role: "link",
        accessibleName: "Docs",
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent(/link "Docs"/),
    );

    // Second event: testid. Chip should update, not stack.
    await act(async () => {
      await emit("picker_hover_preview", { testId: "save-btn" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent(/testid "save-btn"/),
    );
  });
});

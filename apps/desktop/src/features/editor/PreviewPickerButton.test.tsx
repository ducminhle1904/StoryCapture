/**
 * PreviewPickerButton vitest — Phase 11-04 disambiguation proof.
 *
 * Core invariants (UI-SPEC §Copywriting LOCKED):
 *   D-13: disabled when AuthorDriverState=simulator-running
 *   D-14: enabled when AuthorDriverState=simulator-paused
 *   D-04: first-pick (wasFreshlyStamped=true)  → toast `Added ...`
 *         re-pick   (wasFreshlyStamped=false)  → toast `Updated fallback for step {N}`
 *   D-09: Esc during picking invokes pickElementCancel
 *   D-15: simulator-running click is a no-op (does not invoke picker_start_author)
 *
 * We bridge the mockIPC layer ({ json } envelope) to the Phase 11-03
 * `picker_start_author` contract; `picker_stamp_step_id` returns the DTO
 * shape `{ step_id, was_freshly_stamped }` per 11-01.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

// Mock sonner BEFORE importing the button.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

import { toast } from "sonner";

import { editorController } from "@/features/editor/controller";
import { useAuthorDriverStore } from "@/features/editor/authorDriverStore";
import { useEditorStore } from "@/state/editor";

import { PreviewPickerButton } from "./PreviewPickerButton";

/** Seed the renderer projection to a known state for the test under run. */
function seedAuthorDriver(snapshot: {
  variant: "idle" | "live-preview" | "picking" | "simulator-running" | "simulator-paused";
  streamId?: string | null;
  simulatorOrdinal?: number | null;
}) {
  useAuthorDriverStore.setState({
    variant: snapshot.variant,
    streamId: snapshot.streamId ?? null,
    simulatorOrdinal: snapshot.simulatorOrdinal ?? null,
  });
}

describe("PreviewPickerButton", () => {
  let insertSpy: ReturnType<typeof vi.spyOn>;
  let getCursorSpy: ReturnType<typeof vi.spyOn>;
  let getStoryPathSpy: ReturnType<typeof vi.spyOn>;
  let getStepOrdinalSpy: ReturnType<typeof vi.spyOn>;
  let isDirtySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    insertSpy = vi
      .spyOn(editorController, "insertAtCursor")
      .mockReturnValue({ ok: true, lineNumber: 12 });
    getCursorSpy = vi
      .spyOn(editorController, "getCursorLine")
      .mockReturnValue(12);
    getStoryPathSpy = vi
      .spyOn(editorController, "getStoryPath")
      .mockReturnValue("/tmp/demo.story");
    getStepOrdinalSpy = vi
      .spyOn(editorController, "getStepOrdinalForLine")
      .mockReturnValue(3);
    isDirtySpy = vi.spyOn(editorController, "isDirty").mockReturnValue(false);
    useEditorStore.setState({ source: 'story "demo"\nscene "x"\n' });
    // Default to LivePreview with an active streamId so the button is armed.
    seedAuthorDriver({ variant: "live-preview", streamId: "author-stream-1" });
    // Reset all sonner mocks between tests.
    (toast as unknown as ReturnType<typeof vi.fn>).mockClear?.();
    (toast.success as ReturnType<typeof vi.fn>).mockClear();
    (toast.error as ReturnType<typeof vi.fn>).mockClear();
    (toast.info as ReturnType<typeof vi.fn>).mockClear();
    (toast.warning as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    clearMocks();
    insertSpy.mockRestore();
    getCursorSpy.mockRestore();
    getStoryPathSpy.mockRestore();
    getStepOrdinalSpy.mockRestore();
    isDirtySpy.mockRestore();
    seedAuthorDriver({ variant: "idle", streamId: null });
  });

  // ─────────────────────────────────────────────────────────────────
  // D-13 — disabled during simulator-running
  // ─────────────────────────────────────────────────────────────────
  it("D-13: is disabled when AuthorDriverState=simulator-running", () => {
    seedAuthorDriver({
      variant: "simulator-running",
      streamId: "author-stream-1",
    });
    render(<PreviewPickerButton />);
    const button = screen.getByRole("button", { name: /pick element/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Simulator running — cancel to pick",
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // D-14 — enabled + clickable during simulator-paused
  // ─────────────────────────────────────────────────────────────────
  it("D-14: is enabled when AuthorDriverState=simulator-paused; click dispatches picker_start_author with streamId", async () => {
    seedAuthorDriver({
      variant: "simulator-paused",
      streamId: "author-stream-1",
      simulatorOrdinal: 4,
    });

    const invokeLog: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => {
      invokeLog.push({ cmd, args });
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click button "Save"',
            locator: { kind: "role", value: { role: "button", name: "Save" } },
            candidates: [],
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return { step_id: "01900000-0000-7000-8000-000000000000", was_freshly_stamped: true };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    const button = screen.getByRole("button", { name: /pick element/i });
    expect(button).not.toBeDisabled();

    await user.click(button);

    const startInvoke = invokeLog.find((e) => e.cmd === "picker_start_author");
    expect(startInvoke).toBeDefined();
    expect(startInvoke!.args).toMatchObject({
      streamId: "author-stream-1",
      cursorLine: 12,
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // D-04 — first-pick toast copy (wasFreshlyStamped=true)
  // ─────────────────────────────────────────────────────────────────
  it("D-04 first-pick: wasFreshlyStamped=true → toast.success with 'Added ... · line L'", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click button "Save"',
            locator: { kind: "role", value: { role: "button", name: "Save" } },
            candidates: [],
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return { step_id: "01900000-0000-7000-8000-aaaaaaaaaaaa", was_freshly_stamped: true };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // Wait for the async chain (stamp + toast) to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(toast.success).toHaveBeenCalled();
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // UI-SPEC-locked first-pick copy: "Added `{emitted}` · line {L}"
    expect(msg).toContain("Added `click button \"Save\"`");
    expect(msg).toContain("line 12");
    expect(msg).not.toContain("Updated fallback");
  });

  // ─────────────────────────────────────────────────────────────────
  // D-04 — re-pick toast copy (wasFreshlyStamped=false)
  // ─────────────────────────────────────────────────────────────────
  it("D-04 re-pick: wasFreshlyStamped=false → toast.success with 'Updated fallback for step N'", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click testid "save"',
            locator: { kind: "testid", value: "save" },
            candidates: [],
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return { step_id: "01900000-0000-7000-8000-bbbbbbbbbbbb", was_freshly_stamped: false };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(toast.success).toHaveBeenCalled();
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // UI-SPEC-locked re-pick copy: "Updated fallback for step {N}"
    // stepOrdinal was stubbed to 3 in beforeEach.
    expect(msg).toBe("Updated fallback for step 3");
    expect(msg).not.toContain("Added");
  });

  // ─────────────────────────────────────────────────────────────────
  // user-cancel path — silent, no insertAtCursor
  // ─────────────────────────────────────────────────────────────────
  it("user-cancel: no toast, no insertAtCursor call", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({ cancelled: true, reason: "user-cancel" }),
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(insertSpy).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // Esc during picking → pickElementCancel invoked
  // ─────────────────────────────────────────────────────────────────
  it("Esc during picking invokes pickElementCancel", async () => {
    // Keep the picker in flight so the keydown listener is mounted.
    let resolvePick!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolvePick = r;
    });
    const invokeLog: string[] = [];
    mockIPC((cmd) => {
      invokeLog.push(cmd);
      if (cmd === "picker_start_author") return pending;
      if (cmd === "picker_cancel") return null;
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));

    // Let the effect hook attach.
    await new Promise((r) => setTimeout(r, 0));

    // Fire Esc.
    await user.keyboard("{Escape}");
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeLog).toContain("picker_cancel");

    // Resolve the pending pick to clean up (cancelled response).
    resolvePick({
      json: JSON.stringify({ cancelled: true, reason: "user-cancel" }),
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Tooltip copy is the UI-SPEC-locked string per variant
  // ─────────────────────────────────────────────────────────────────
  it("renders UI-SPEC tooltip copy per variant", () => {
    // Idle
    seedAuthorDriver({ variant: "idle", streamId: null });
    const { rerender } = render(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Pick element · starts Preview");

    // LivePreview
    seedAuthorDriver({ variant: "live-preview", streamId: "s1" });
    rerender(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Pick element · ⌘⇧P");

    // SimulatorRunning
    seedAuthorDriver({ variant: "simulator-running", streamId: "s1" });
    rerender(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Simulator running — cancel to pick");

    // SimulatorPaused with ordinal → includes {N}
    seedAuthorDriver({
      variant: "simulator-paused",
      streamId: "s1",
      simulatorOrdinal: 7,
    });
    rerender(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute(
      "title",
      "Paused at step 7 — Pick will resume Preview after",
    );
  });
});

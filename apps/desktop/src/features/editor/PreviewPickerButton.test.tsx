/**
 * PreviewPickerButton vitest — Phase 11-04 disambiguation proof + the
 * Phase-1 two-step picker action menu (pick → menu → choose → insert).
 *
 * Core invariants (UI-SPEC §Copywriting LOCKED):
 *   D-13: disabled when AuthorDriverState=simulator-running
 *   D-14: enabled when AuthorDriverState=simulator-paused
 *   D-04: first-pick (wasFreshlyStamped=true)  → toast `Added ...`
 *         re-pick   (wasFreshlyStamped=false)  → toast `Updated fallback for step {N}`
 *   D-09: Esc during picking invokes pickElementCancel
 *   D-15: simulator-running click is a no-op (does not invoke picker_start_author)
 *
 * Phase 1 invariants (action menu):
 *   - After Picked, menu appears; insert + stamp are deferred.
 *   - Each action (click / hover / wait-for / assert) writes the right DSL line.
 *   - Cancelling the menu (Escape) does not insert or stamp.
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

/** Mock IPC for a successful pick of a button "Save". */
function mockPickButtonSave(stamp: { wasFreshlyStamped: boolean }) {
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
      return {
        step_id: "01900000-0000-7000-8000-000000000000",
        was_freshly_stamped: stamp.wasFreshlyStamped,
      };
    }
    return undefined;
  });
}

/** Wait for any pending microtasks/timers in the click → menu chain. */
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("PreviewPickerButton", () => {
  let insertSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  let getCursorSpy: ReturnType<typeof vi.spyOn>;
  let getCursorLineTextSpy: ReturnType<typeof vi.spyOn>;
  let getStoryPathSpy: ReturnType<typeof vi.spyOn>;
  let getStepOrdinalSpy: ReturnType<typeof vi.spyOn>;
  let isDirtySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    insertSpy = vi
      .spyOn(editorController, "insertAtCursor")
      .mockReturnValue({ ok: true, lineNumber: 12 });
    replaceSpy = vi
      .spyOn(editorController, "replaceCursorLine")
      .mockReturnValue({ ok: true, lineNumber: 12 });
    getCursorSpy = vi
      .spyOn(editorController, "getCursorLine")
      .mockReturnValue(12);
    getCursorLineTextSpy = vi
      .spyOn(editorController, "getCursorLineText")
      .mockReturnValue("");
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
    replaceSpy.mockRestore();
    getCursorSpy.mockRestore();
    getCursorLineTextSpy.mockRestore();
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
  // Phase-1 menu: appears after pick, no immediate insert/stamp
  // ─────────────────────────────────────────────────────────────────
  it("after Picked, action menu appears and nothing is inserted/stamped yet", async () => {
    const invokeLog: string[] = [];
    mockIPC((cmd) => {
      invokeLog.push(cmd);
      if (cmd === "picker_start_author") {
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
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    expect(screen.getByRole("dialog", { name: /picker action menu/i })).toBeTruthy();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(invokeLog).not.toContain("picker_stamp_step_id");
  });

  // ─────────────────────────────────────────────────────────────────
  // D-04 — first-pick toast copy via the menu (Click action)
  // ─────────────────────────────────────────────────────────────────
  it("D-04 first-pick: choosing Click → toast.success with 'Added ... · line L'", async () => {
    mockPickButtonSave({ wasFreshlyStamped: true });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /click element/i }));
    await flushAsync();

    expect(toast.success).toHaveBeenCalled();
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // UI-SPEC-locked first-pick copy: "Added `{emitted}` · line {L}"
    expect(msg).toContain("Added `click button \"Save\"`");
    expect(msg).toContain("line 12");
    expect(msg).not.toContain("Updated fallback");
  });

  // ─────────────────────────────────────────────────────────────────
  // D-04 — re-pick toast copy via the menu (testid locator)
  // ─────────────────────────────────────────────────────────────────
  it("D-04 re-pick: wasFreshlyStamped=false → toast.success 'Updated fallback for step N'", async () => {
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
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /click element/i }));
    await flushAsync();

    expect(toast.success).toHaveBeenCalled();
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // UI-SPEC-locked re-pick copy: "Updated fallback for step {N}" (stub=3).
    expect(msg).toBe("Updated fallback for step 3");
  });

  // ─────────────────────────────────────────────────────────────────
  // Hover action: inserts `hover ...`
  // ─────────────────────────────────────────────────────────────────
  it("choosing Hover inserts `hover button \"Save\"`", async () => {
    mockPickButtonSave({ wasFreshlyStamped: true });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();
    await user.click(screen.getByRole("menuitem", { name: /hover element/i }));
    await flushAsync();

    expect(insertSpy).toHaveBeenCalledWith('hover button "Save"\n');
  });

  // ─────────────────────────────────────────────────────────────────
  // Wait-for action: appends default 5s timeout
  // ─────────────────────────────────────────────────────────────────
  it("choosing Wait for inserts `wait-for ... timeout 5s`", async () => {
    mockPickButtonSave({ wasFreshlyStamped: true });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();
    await user.click(screen.getByRole("menuitem", { name: /wait for element/i }));
    await flushAsync();

    expect(insertSpy).toHaveBeenCalledWith('wait-for button "Save" timeout 5s\n');
  });

  // ─────────────────────────────────────────────────────────────────
  // Wait-for re-pick preserves existing timeout
  // ─────────────────────────────────────────────────────────────────
  it("choosing Wait for on existing `wait-for ... timeout 10s` preserves the 10s", async () => {
    getCursorLineTextSpy.mockReturnValue('    wait-for text "Old" timeout 10s');
    mockPickButtonSave({ wasFreshlyStamped: false });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();
    await user.click(screen.getByRole("menuitem", { name: /wait for element/i }));
    await flushAsync();

    expect(replaceSpy).toHaveBeenCalledWith(
      '    wait-for button "Save" timeout 10s',
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // Assert action
  // ─────────────────────────────────────────────────────────────────
  it("choosing Assert inserts `assert button \"Save\"`", async () => {
    mockPickButtonSave({ wasFreshlyStamped: true });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();
    await user.click(screen.getByRole("menuitem", { name: /assert element/i }));
    await flushAsync();

    expect(insertSpy).toHaveBeenCalledWith('assert button "Save"\n');
  });

  // ─────────────────────────────────────────────────────────────────
  // Escape on the menu cancels — no insert, no stamp, silent.
  // ─────────────────────────────────────────────────────────────────
  it("Escape on action menu does not insert and does not stamp", async () => {
    const invokeLog: string[] = [];
    mockIPC((cmd) => {
      invokeLog.push(cmd);
      if (cmd === "picker_start_author") {
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
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    expect(screen.getByRole("dialog", { name: /picker action menu/i })).toBeTruthy();
    await user.keyboard("{Escape}");
    await flushAsync();

    expect(screen.queryByRole("dialog", { name: /picker action menu/i })).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(invokeLog).not.toContain("picker_stamp_step_id");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // Existing-line verb sets the menu's default action.
  // ─────────────────────────────────────────────────────────────────
  it("default-focused menu item matches the existing line's verb", async () => {
    getCursorLineTextSpy.mockReturnValue('    hover field "Old"');
    mockPickButtonSave({ wasFreshlyStamped: false });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    expect(
      screen.getByRole("menuitem", { name: /hover element/i }),
    ).toHaveFocus();
  });

  // ─────────────────────────────────────────────────────────────────
  // user-cancel path — silent, no menu, no insertAtCursor
  // ─────────────────────────────────────────────────────────────────
  it("user-cancel from sidecar: no menu, no insert, no toast", async () => {
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
    await flushAsync();

    expect(screen.queryByRole("dialog", { name: /picker action menu/i })).toBeNull();
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

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

// Mock the Tauri dialog plugin so upload-action tests can run in jsdom.
// Each test re-stubs `open` to return its own path (or `null` for cancel).
const dialogOpenMock = vi.fn<() => Promise<string | null>>();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...(args as [])),
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
    dialogOpenMock.mockReset();
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
    expect(msg).toContain("Added `click button \"Save\"`");
    expect(msg).toContain("line 12");
    expect(msg).not.toContain("Updated fallback");
  });

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
    expect(msg).toBe("Updated fallback for step 3");
  });

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

  it("text-input metadata promotes Fill text… as the first action", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click field "Email"',
            locator: { kind: "label", value: "Email" },
            candidates: [],
            element: { isTextInput: true, tagName: "INPUT", inputType: "email" },
          }),
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    const items = screen.getAllByRole("menuitem");
    expect(items[0].textContent).toMatch(/fill text/i);
    expect(items[1].textContent).toMatch(/type text/i);
  });

  it("choosing Fill text…, entering text, submitting inserts a fill line", async () => {
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click field "Email"',
            locator: { kind: "label", value: "Email" },
            candidates: [],
            element: { isTextInput: true, tagName: "INPUT", inputType: "email" },
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return {
          step_id: "01900000-0000-7000-8000-000000000000",
          was_freshly_stamped: true,
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /fill text/i }));
    await flushAsync();

    const input = screen.getByRole("textbox");
    await user.type(input, "alice@example.com");
    await user.click(screen.getByRole("button", { name: /^insert$/i }));
    await flushAsync();

    expect(insertSpy).toHaveBeenCalledWith(
      'fill field "Email" with "alice@example.com"\n',
    );
  });

  it("choosing Upload file… opens the file dialog and inserts an upload line", async () => {
    dialogOpenMock.mockResolvedValueOnce("/tmp/photo.png");
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click selector "input[type=file]"',
            locator: { kind: "selector", value: "input[type=file]" },
            candidates: [],
            element: { isFileInput: true, tagName: "INPUT", inputType: "file" },
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return {
          step_id: "01900000-0000-7000-8000-000000000000",
          was_freshly_stamped: true,
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /upload file/i }));
    await flushAsync();

    expect(dialogOpenMock).toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledWith(
      'upload selector "input[type=file]" "/tmp/photo.png"\n',
    );
  });

  it("cancelling the upload file dialog does not insert", async () => {
    dialogOpenMock.mockResolvedValueOnce(null);
    mockIPC((cmd) => {
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click selector "input[type=file]"',
            locator: { kind: "selector", value: "input[type=file]" },
            candidates: [],
            element: { isFileInput: true },
          }),
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /upload file/i }));
    await flushAsync();

    expect(insertSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  // Drag skips stamp because `.story.targets.json` doesn't model two
  // targets per step yet.
  it("choosing Drag from here… runs a second pick and inserts a drag line without stamping", async () => {
    let pickCount = 0;
    const invokeLog: string[] = [];
    mockIPC((cmd) => {
      invokeLog.push(cmd);
      if (cmd === "picker_start_author") {
        pickCount += 1;
        if (pickCount === 1) {
          return {
            json: JSON.stringify({
              emitted: 'click testid "src"',
              locator: { kind: "testid", value: "src" },
              candidates: [],
            }),
          };
        }
        return {
          json: JSON.stringify({
            emitted: 'click testid "dst"',
            locator: { kind: "testid", value: "dst" },
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

    await user.click(screen.getByRole("menuitem", { name: /drag from here/i }));
    await flushAsync();

    expect(pickCount).toBe(2);
    expect(insertSpy).toHaveBeenCalledWith('drag testid "src" to testid "dst"\n');
    expect(invokeLog).not.toContain("picker_stamp_step_id");
    const successMsg = (toast.success as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(successMsg).toMatch(/selector healing for drag targets/i);
  });

  it("generator returns locator with nth=2 → click inserts nth-postfixed line and stamps with nth", async () => {
    const invokeLog: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => {
      invokeLog.push({ cmd, args });
      if (cmd === "picker_start_author") {
        return {
          json: JSON.stringify({
            emitted: 'click testid "row" nth 2',
            locator: { kind: "testid", value: "row", nth: 2 },
            candidates: [
              {
                kind: "testid",
                value: "row",
                score: 0.95,
                unique: false,
                nth: 2,
              },
            ],
          }),
        };
      }
      if (cmd === "picker_stamp_step_id") {
        return {
          step_id: "01900000-0000-7000-8000-000000000000",
          was_freshly_stamped: true,
        };
      }
      return undefined;
    });

    const user = userEvent.setup();
    render(<PreviewPickerButton />);
    await user.click(screen.getByRole("button", { name: /pick element/i }));
    await flushAsync();

    await user.click(screen.getByRole("menuitem", { name: /click element/i }));
    await flushAsync();

    expect(insertSpy).toHaveBeenCalledWith('click testid "row" nth 2\n');

    const stampInvoke = invokeLog.find((e) => e.cmd === "picker_stamp_step_id");
    expect(stampInvoke).toBeDefined();
    expect(stampInvoke!.args).toMatchObject({
      primary: { kind: "testid", value: "row", nth: 2 },
    });
    const fallbacks = (stampInvoke!.args as { fallbacks: unknown[] }).fallbacks;
    expect(fallbacks[0]).toMatchObject({
      kind: "testid",
      value: "row",
      nth: 2,
    });
  });

  it("renders UI-SPEC tooltip copy per variant", () => {
    seedAuthorDriver({ variant: "idle", streamId: null });
    const { rerender } = render(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Pick element · starts Preview");

    seedAuthorDriver({ variant: "live-preview", streamId: "s1" });
    rerender(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Pick element · ⌘⇧P");

    seedAuthorDriver({ variant: "simulator-running", streamId: "s1" });
    rerender(<PreviewPickerButton />);
    expect(
      screen.getByRole("button", { name: /pick element/i }),
    ).toHaveAttribute("title", "Simulator running — cancel to pick");

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

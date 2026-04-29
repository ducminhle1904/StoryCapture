import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock IPC invoke before importing the component.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as Parameters<typeof invokeMock>)),
}));

type PreviewListener = (ev: { payload: unknown }) => void;
const listenMock = vi.fn<(event: string, handler: PreviewListener) => Promise<() => void>>();
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: PreviewListener) => listenMock(event, handler),
}));

const frontendWarnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({
  frontendLog: {
    warn: frontendWarnMock,
  },
}));

import { LivePreview } from "./live-preview";

// ─── fakes ─────────────────────────────────────────────────────────────

class FakeImageBitmap {
  width: number;
  height: number;
  closed = false;
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
  }
  close() {
    this.closed = true;
  }
}

let capturedHandler: PreviewListener | null = null;
const createdBitmaps: FakeImageBitmap[] = [];
const drawCalls: FakeImageBitmap[] = [];
const bitmapSizes: Array<{ width: number; height: number }> = [];

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  unlistenSpy.mockReset();
  frontendWarnMock.mockReset();
  capturedHandler = null;
  createdBitmaps.length = 0;
  drawCalls.length = 0;
  bitmapSizes.length = 0;

  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "start_preview_stream" || cmd === "stop_preview_stream") return null;
    throw new Error(`unexpected invoke ${cmd}`);
  });
  listenMock.mockImplementation(async (_event, handler) => {
    capturedHandler = handler;
    return unlistenSpy;
  });

  // createImageBitmap isn't in happy-dom; stub a fake.
  vi.stubGlobal("createImageBitmap", async (_blob: Blob) => {
    const size = bitmapSizes.shift() ?? { width: 1, height: 1 };
    const bmp = new FakeImageBitmap(size.width, size.height);
    createdBitmaps.push(bmp);
    return bmp;
  });

  // Canvas 2D context is partially implemented by happy-dom; spy on drawImage.
  const drawImage = vi.fn((bmp: unknown) => {
    drawCalls.push(bmp as FakeImageBitmap);
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  // Let startPreviewStream + listen + setStatus settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function holdAnimationFrames() {
  let pendingRaf: FrameRequestCallback | null = null;
  const spy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb: FrameRequestCallback) => {
      pendingRaf = cb;
      return 1;
    });
  return {
    get pending() {
      return pendingRaf;
    },
    async tick() {
      await act(async () => {
        pendingRaf?.(0);
      });
    },
    restore() {
      spy.mockRestore();
    },
  };
}

// ─── tests ─────────────────────────────────────────────────────────────

describe("<LivePreview />", () => {
  it("α — attaches listener + stops on unmount", async () => {
    const { unmount } = render(<LivePreview />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_preview_stream");
    });
    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("preview://frame", expect.any(Function));
    });

    unmount();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("stop_preview_stream");
  });

  it("β — decodes a frame, draws on rAF, closes the bitmap", async () => {
    // Store the latest pending rAF callback; fire it manually after the
    // frame handler resolves so we observe exactly one draw tick.
    const raf = holdAnimationFrames();

    render(<LivePreview />);
    await flush();
    expect(capturedHandler).not.toBeNull();

    // Feed a synthetic preview frame.
    await act(async () => {
      await capturedHandler!({
        payload: {
          data: "AAAA",
          width: 1,
          height: 1,
          timestamp: 1,
        },
      });
    });

    expect(createdBitmaps.length).toBeGreaterThanOrEqual(1);
    // Drive one rAF tick to pick up the pending bitmap.
    expect(raf.pending).not.toBeNull();
    await raf.tick();

    expect(drawCalls.length).toBeGreaterThanOrEqual(1);
    expect(createdBitmaps[0].closed).toBe(true);

    raf.restore();
  });

  it("β₂ — exposes frame and bitmap dimensions for mismatch diagnostics", async () => {
    const raf = holdAnimationFrames();
    bitmapSizes.push({ width: 1152, height: 720 });

    render(<LivePreview width={1280} height={800} />);
    await flush();
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      await capturedHandler?.({
        payload: {
          data: "AAAA",
          width: 1280,
          height: 800,
          timestamp: 1,
        },
      });
    });

    const canvas = screen.getByTestId("live-preview-canvas");
    expect(canvas.getAttribute("data-frame-width")).toBe("1280");
    expect(canvas.getAttribute("data-frame-height")).toBe("800");
    expect(canvas.getAttribute("data-bitmap-width")).toBe("1152");
    expect(canvas.getAttribute("data-bitmap-height")).toBe("720");
    expect(frontendWarnMock).toHaveBeenCalledWith(
      "LivePreview",
      "frame dimension mismatch",
      expect.objectContaining({
        fields: expect.objectContaining({
          frame_width: 1280,
          frame_height: 800,
          bitmap_width: 1152,
          bitmap_height: 720,
          canvas_width: 1280,
          canvas_height: 800,
        }),
      }),
    );

    await raf.tick();
    raf.restore();
  });

  it("γ — renders placeholder + skips listen when backend is unavailable", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_preview_stream") {
        throw { kind: "UnavailableOnBackend", message: "no active Playwright session" };
      }
      return null;
    });

    render(<LivePreview />);
    await waitFor(() => {
      expect(screen.getByTestId("live-preview-unavailable")).toBeInTheDocument();
    });
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("δ — re-mount restarts the stream", async () => {
    const { unmount } = render(<LivePreview />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_preview_stream");
    });
    unmount();

    invokeMock.mockClear();
    listenMock.mockClear();

    render(<LivePreview />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_preview_stream");
    });
    expect(listenMock).toHaveBeenCalledWith("preview://frame", expect.any(Function));
  });

  // Exactly ONE retry on transient failure, 500ms backoff.
  it("ε — transient start failure retries once and reaches streaming", async () => {
    let startCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_preview_stream") {
        startCalls++;
        if (startCalls === 1) {
          throw { kind: "Automation", message: "transient sidecar blip" };
        }
        return null;
      }
      if (cmd === "stop_preview_stream") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    render(<LivePreview />);
    // Retry happens after 500ms real backoff; give it room.
    await waitFor(
      () => {
        expect(startCalls).toBe(2);
      },
      { timeout: 2000 },
    );
    await waitFor(() => {
      expect(screen.getByTestId("live-preview-canvas")).toBeInTheDocument();
    });
  });

  // Second failure after retry → terminal 'unavailable'. No third attempt.
  it("ζ — two transient failures land in unavailable (no third retry)", async () => {
    let startCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_preview_stream") {
        startCalls++;
        throw { kind: "Automation", message: "blip " + startCalls };
      }
      if (cmd === "stop_preview_stream") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    render(<LivePreview />);
    await waitFor(
      () => {
        expect(screen.getByTestId("live-preview-unavailable")).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.getByTestId("live-preview-unavailable").textContent).toMatch(
      /Live preview unavailable on this backend/i,
    );
    // Ensure no third retry fires.
    await new Promise((r) => setTimeout(r, 700));
    expect(startCalls).toBe(2);
  });

  // UnavailableOnBackend is terminal — no retry scheduled.
  it("η — UnavailableOnBackend is terminal (no retry)", async () => {
    let startCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "start_preview_stream") {
        startCalls++;
        throw { kind: "UnavailableOnBackend", message: "no session" };
      }
      if (cmd === "stop_preview_stream") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    render(<LivePreview />);
    await waitFor(() => {
      expect(screen.getByTestId("live-preview-unavailable")).toBeInTheDocument();
    });
    // Give extra macrotasks a chance — terminal path must not retry.
    await new Promise((r) => setTimeout(r, 700));
    expect(startCalls).toBe(1);
  });

  // When streamId is set, the component listens on the per-stream event
  // channel and skips the recording-session start/stop lifecycle.
  it("ι — streamId prop listens on preview://frame/<id> and skips start_preview_stream", async () => {
    let pendingRaf: FrameRequestCallback | null = null;
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        pendingRaf = cb;
        return 1;
      });

    render(<LivePreview streamId="author-123" />);
    await flush();

    expect(invokeMock).not.toHaveBeenCalledWith("start_preview_stream");
    expect(listenMock).toHaveBeenCalledWith("preview://frame/author-123", expect.any(Function));
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      await capturedHandler!({
        payload: { data: "AAAA", width: 1, height: 1, timestamp: 1 },
      });
    });
    expect(createdBitmaps.length).toBe(1);

    if (pendingRaf) {
      await act(async () => {
        pendingRaf!(0);
      });
    }
    rafSpy.mockRestore();
  });

  // ─── keyboard forwarding ────────────────────────────────────────────

  const dispatchedKeyboardEvents = (): Array<Record<string, unknown>> =>
    invokeMock.mock.calls
      .filter((c) => c[0] === "author_dispatch_input")
      .map((c) => (c[1] as { event: Record<string, unknown> }).event);

  it("κ — streamId+pageWidth/Height enables tabIndex=0 + bound listeners", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("data-input-enabled")).toBe("true");
  });

  it("λ — keydown 'a' forwards a keydown event over IPC", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    const events = dispatchedKeyboardEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "keydown",
        key: "a",
        code: "KeyA",
        repeat: false,
      }),
    );
  });

  it("μ — keydown Tab calls preventDefault", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    const evt = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("ν — Cmd+, escapes to the app: no dispatch, no preventDefault", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    invokeMock.mockClear();
    const canvas = screen.getByTestId("live-preview-canvas");
    const evt = new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(invokeMock.mock.calls.some((c) => c[0] === "author_dispatch_input")).toBe(false);
  });

  it("ξ — pickerArmed=true short-circuits keyboard dispatch", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} pickerArmed />);
    await flush();
    invokeMock.mockClear();
    const canvas = screen.getByTestId("live-preview-canvas");
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "author_dispatch_input")).toBe(false);
  });

  it("ο — paste event forwards clipboard contents as a text event", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    fireEvent.paste(canvas, {
      clipboardData: { getData: () => "hello" },
    });
    const events = dispatchedKeyboardEvents();
    expect(events).toContainEqual({ type: "text", text: "hello" });
  });

  it("ο₂ — compositionend forwards composed (IME) text as a text event", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    // happy-dom's CompositionEvent doesn't honor `data` from fireEvent;
    // dispatch a plain Event and pin `data` so the handler sees it.
    const evt = new Event("compositionend", { bubbles: true });
    Object.defineProperty(evt, "data", { value: "xin chào" });
    canvas.dispatchEvent(evt);
    const events = dispatchedKeyboardEvents();
    expect(events).toContainEqual({ type: "text", text: "xin chào" });
  });

  it("π — blur while Shift held synthesizes a Shift keyup", async () => {
    invokeMock.mockImplementation(async () => null);
    render(<LivePreview streamId="author-x" pageWidth={800} pageHeight={600} />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    fireEvent.keyDown(canvas, { key: "Shift", code: "ShiftLeft" });
    invokeMock.mockClear();
    fireEvent.blur(canvas);
    const events = dispatchedKeyboardEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "keyup",
        key: "Shift",
        code: "ShiftLeft",
      }),
    );
  });

  it("ρ — input disabled (no streamId) → tabIndex=-1, no key listeners", async () => {
    render(<LivePreview />);
    await flush();
    const canvas = screen.getByTestId("live-preview-canvas");
    expect(canvas.getAttribute("tabindex")).toBe("-1");
    expect(canvas.getAttribute("data-input-enabled")).toBe("false");
    invokeMock.mockClear();
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(invokeMock.mock.calls.some((c) => c[0] === "author_dispatch_input")).toBe(false);
  });

  // Saturation — two frames arriving back-to-back before rAF draws bumps
  // data-drop-count from "0" to "1".
  it("θ — webview drop counter increments on back-to-back frames", async () => {
    // Hold rAF so pendingBitmap.current never clears between frames.
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);

    render(<LivePreview />);
    await flush();
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      await capturedHandler!({
        payload: { data: "AAAA", width: 1, height: 1, timestamp: 1 },
      });
    });
    await act(async () => {
      await capturedHandler!({
        payload: { data: "BBBB", width: 1, height: 1, timestamp: 2 },
      });
    });

    const canvas = screen.getByTestId("live-preview-canvas");
    await waitFor(() => {
      expect(canvas.getAttribute("data-drop-count")).toBe("1");
    });
    rafSpy.mockRestore();
  });
});

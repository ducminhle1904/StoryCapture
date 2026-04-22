import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// Mock IPC invoke before importing the component.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) =>
    invokeMock(...(args as Parameters<typeof invokeMock>)),
}));

type PreviewListener = (ev: { payload: unknown }) => void;
const listenMock = vi.fn<
  (event: string, handler: PreviewListener) => Promise<() => void>
>();
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: PreviewListener) => listenMock(event, handler),
}));

import { LivePreview } from "./live-preview";

// ─── fakes ─────────────────────────────────────────────────────────────

class FakeImageBitmap {
  closed = false;
  close() {
    this.closed = true;
  }
}

let capturedHandler: PreviewListener | null = null;
const createdBitmaps: FakeImageBitmap[] = [];
const drawCalls: FakeImageBitmap[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  unlistenSpy.mockReset();
  capturedHandler = null;
  createdBitmaps.length = 0;
  drawCalls.length = 0;

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
    const bmp = new FakeImageBitmap();
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

// ─── tests ─────────────────────────────────────────────────────────────

describe("<LivePreview />", () => {
  it("α — attaches listener + stops on unmount", async () => {
    const { unmount } = render(<LivePreview />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_preview_stream");
    });
    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith(
        "preview://frame",
        expect.any(Function),
      );
    });

    unmount();
    expect(unlistenSpy).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("stop_preview_stream");
  });

  it("β — decodes a frame, draws on rAF, closes the bitmap", async () => {
    // Store the latest pending rAF callback; fire it manually after the
    // frame handler resolves so we observe exactly one draw tick.
    let pendingRaf: FrameRequestCallback | null = null;
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        pendingRaf = cb;
        return 1;
      });

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
    expect(pendingRaf).not.toBeNull();
    await act(async () => {
      pendingRaf!(0);
    });

    expect(drawCalls.length).toBeGreaterThanOrEqual(1);
    expect(createdBitmaps[0].closed).toBe(true);

    rafSpy.mockRestore();
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
      expect(
        screen.getByTestId("live-preview-unavailable"),
      ).toBeInTheDocument();
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
    expect(listenMock).toHaveBeenCalledWith(
      "preview://frame",
      expect.any(Function),
    );
  });

  // Phase 09-03 — exactly ONE retry on transient failure, 500ms backoff.
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
      expect(
        screen.getByTestId("live-preview-canvas"),
      ).toBeInTheDocument();
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
        expect(
          screen.getByTestId("live-preview-unavailable"),
        ).toBeInTheDocument();
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
      expect(
        screen.getByTestId("live-preview-unavailable"),
      ).toBeInTheDocument();
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
    expect(listenMock).toHaveBeenCalledWith(
      "preview://frame/author-123",
      expect.any(Function),
    );
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      await capturedHandler!({
        payload: { data: "AAAA", width: 1, height: 1, timestamp: 1 },
      });
    });
    expect(createdBitmaps.length).toBe(1);

    if (pendingRaf) {
      await act(async () => { pendingRaf!(0); });
    }
    rafSpy.mockRestore();
  });

  // Saturation — two frames arriving back-to-back before rAF draws bumps
  // data-drop-count from "0" to "1".
  it("θ — webview drop counter increments on back-to-back frames", async () => {
    // Hold rAF so pendingBitmap.current never clears between frames.
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);

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

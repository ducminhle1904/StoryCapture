import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => ({
  acquirePreview:
    vi.fn<
      (appUrl: string, viewport: string, listener: (streamId: string | null) => void) => () => void
    >(),
  pausePreview: vi.fn(),
  resumePreview: vi.fn(),
  subscribeNav:
    vi.fn<
      (
        listener: (state: {
          url: string | null;
          canGoBack: boolean;
          canGoForward: boolean;
        }) => void,
      ) => () => void
    >(),
  subscribeStatus:
    vi.fn<(listener: (status: "idle" | "starting" | "live" | "error") => void) => () => void>(),
  updateAppUrl: vi.fn(),
  updateViewport: vi.fn(),
}));

vi.mock("@/features/editor/preview-lifecycle", () => ({
  acquirePreview: lifecycleMocks.acquirePreview,
  INITIAL_NAV: {
    url: null,
    canGoBack: false,
    canGoForward: false,
  },
  pausePreview: lifecycleMocks.pausePreview,
  resumePreview: lifecycleMocks.resumePreview,
  subscribeNav: lifecycleMocks.subscribeNav,
  subscribeStatus: lifecycleMocks.subscribeStatus,
  updateAppUrl: lifecycleMocks.updateAppUrl,
  updateViewport: lifecycleMocks.updateViewport,
}));

vi.mock("@/state/editor", () => ({
  useEditorStore: (selector: (state: { previewViewport: "desktop" }) => unknown) =>
    selector({ previewViewport: "desktop" }),
}));

vi.mock("@/state/simulator-store", () => ({
  useSimulatorStore: (selector: (state: { runState: "idle" }) => unknown) =>
    selector({ runState: "idle" }),
}));

import { useEditorLivePreview } from "./use-editor-live-preview";

const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";

async function advanceColdStart(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  lifecycleMocks.acquirePreview.mockReset();
  lifecycleMocks.pausePreview.mockReset();
  lifecycleMocks.resumePreview.mockReset();
  lifecycleMocks.subscribeNav.mockReset();
  lifecycleMocks.subscribeStatus.mockReset();
  lifecycleMocks.updateAppUrl.mockReset();
  lifecycleMocks.updateViewport.mockReset();

  lifecycleMocks.subscribeNav.mockImplementation((listener) => {
    listener({ url: null, canGoBack: false, canGoForward: false });
    return vi.fn();
  });
  lifecycleMocks.subscribeStatus.mockImplementation((listener) => {
    listener("idle");
    return vi.fn();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useEditorLivePreview", () => {
  it("acquires one preview with the validated URL after the cold-start defer", async () => {
    const release = vi.fn();
    lifecycleMocks.acquirePreview.mockImplementation((appUrl, _viewport, listener) => {
      listener("stream-1");
      expect(appUrl).toBe(URL_A);
      return release;
    });

    const { result } = renderHook(() => useEditorLivePreview(URL_A));
    expect(result.current.appUrlValid).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(lifecycleMocks.acquirePreview).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(lifecycleMocks.acquirePreview).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.acquirePreview).toHaveBeenCalledWith(
      URL_A,
      "desktop",
      expect.any(Function),
    );
    expect(result.current.streamId).toBe("stream-1");
  });

  it("does not issue a second URL update when the acquire listener supplies a stream", async () => {
    lifecycleMocks.acquirePreview.mockImplementation((_appUrl, _viewport, listener) => {
      listener("stream-1");
      return vi.fn();
    });

    renderHook(() => useEditorLivePreview(URL_A));
    await advanceColdStart();

    expect(lifecycleMocks.acquirePreview).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.updateAppUrl).not.toHaveBeenCalled();
  });

  it("releases the old acquire before acquiring a changed URL once", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    let acquireCount = 0;
    lifecycleMocks.acquirePreview.mockImplementation((_appUrl, _viewport, listener) => {
      acquireCount += 1;
      listener(`stream-${acquireCount}`);
      return acquireCount === 1 ? firstRelease : secondRelease;
    });

    const { rerender, unmount } = renderHook(({ appUrl }) => useEditorLivePreview(appUrl), {
      initialProps: { appUrl: URL_A },
    });
    await advanceColdStart();

    rerender({ appUrl: URL_B });
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.acquirePreview).toHaveBeenCalledTimes(1);

    await advanceColdStart();
    expect(lifecycleMocks.acquirePreview.mock.calls.map(([appUrl]) => appUrl)).toEqual([
      URL_A,
      URL_B,
    ]);

    unmount();
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it("does not acquire for invalid or null URLs", async () => {
    const initialProps: { appUrl: string | null } = {
      appUrl: "file:///tmp/not-allowed",
    };
    const { rerender, result } = renderHook(
      ({ appUrl }: { appUrl: string | null }) => useEditorLivePreview(appUrl),
      { initialProps },
    );
    await advanceColdStart();
    expect(result.current.appUrlValid).toBe(false);

    rerender({ appUrl: null });
    await advanceColdStart();

    expect(lifecycleMocks.acquirePreview).not.toHaveBeenCalled();
  });
});

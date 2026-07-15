import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  frontendLogInfo: vi.fn(),
  frontendLogWarn: vi.fn(),
  listen: vi.fn(),
  pauseAuthorPreview: vi.fn(),
  resumeAuthorPreview: vi.fn(),
  setAuthorPreviewUrl: vi.fn(),
  setAuthorPreviewViewport: vi.fn(),
  startAuthorPreview: vi.fn(),
  stopAuthorPreview: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@/ipc/preview", () => ({
  pauseAuthorPreview: mocks.pauseAuthorPreview,
  resumeAuthorPreview: mocks.resumeAuthorPreview,
  setAuthorPreviewUrl: mocks.setAuthorPreviewUrl,
  setAuthorPreviewViewport: mocks.setAuthorPreviewViewport,
  startAuthorPreview: mocks.startAuthorPreview,
  stopAuthorPreview: mocks.stopAuthorPreview,
}));

vi.mock("@/lib/log", () => ({
  frontendLog: {
    info: mocks.frontendLogInfo,
    warn: mocks.frontendLogWarn,
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

type PreviewLifecycleModule = typeof import("./preview-lifecycle");

const BASE_URL = "https://base.example.test";
const URL_A = "https://a.example.test";
const URL_B = "https://b.example.test";
const URL_C = "https://c.example.test";

let lifecycle: PreviewLifecycleModule;

async function startSession(streamId: string, appUrl = BASE_URL): Promise<() => void> {
  mocks.startAuthorPreview.mockResolvedValueOnce(streamId);
  const release = lifecycle.acquirePreview(appUrl, "desktop", vi.fn());
  await flushMicrotasks();
  expect(mocks.startAuthorPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({ initialUrl: appUrl }),
  );
  return release;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.frontendLogInfo.mockReset();
  mocks.frontendLogWarn.mockReset();
  mocks.listen.mockReset();
  mocks.pauseAuthorPreview.mockReset();
  mocks.resumeAuthorPreview.mockReset();
  mocks.setAuthorPreviewUrl.mockReset();
  mocks.setAuthorPreviewViewport.mockReset();
  mocks.startAuthorPreview.mockReset();
  mocks.stopAuthorPreview.mockReset();

  mocks.listen.mockResolvedValue(() => {});
  mocks.pauseAuthorPreview.mockResolvedValue(undefined);
  mocks.resumeAuthorPreview.mockResolvedValue(undefined);
  mocks.setAuthorPreviewViewport.mockResolvedValue(undefined);
  mocks.stopAuthorPreview.mockResolvedValue(undefined);

  lifecycle = await import("./preview-lifecycle");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("preview lifecycle app URL coordination", () => {
  it("coalesces duplicate URL requests while navigation is pending", async () => {
    await startSession("stream-1");
    const navigation = deferred<void>();
    mocks.setAuthorPreviewUrl.mockReturnValueOnce(navigation.promise);

    lifecycle.updateAppUrl(URL_A);
    lifecycle.updateAppUrl(URL_A);

    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledTimes(1);
    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledWith("stream-1", URL_A);

    navigation.resolve(undefined);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledTimes(1);
  });

  it("drains the latest URL requested while the preview is starting", async () => {
    const start = deferred<string>();
    mocks.startAuthorPreview.mockReturnValueOnce(start.promise);
    mocks.setAuthorPreviewUrl.mockResolvedValueOnce(undefined);

    const releaseInitial = lifecycle.acquirePreview(BASE_URL, "desktop", vi.fn());
    releaseInitial();
    const latestListener = vi.fn();
    const releaseLatest = lifecycle.acquirePreview(URL_B, "desktop", latestListener);

    expect(mocks.startAuthorPreview).toHaveBeenCalledTimes(1);
    start.resolve("stream-1");
    await flushMicrotasks();

    expect(latestListener).toHaveBeenLastCalledWith("stream-1");
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([["stream-1", URL_B]]);
    releaseLatest();
  });

  it("drains a request queued in the navigation completion microtask", async () => {
    await startSession("stream-1");
    const firstNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(firstNavigation.promise)
      .mockResolvedValueOnce(undefined);

    lifecycle.updateAppUrl(URL_A);
    void firstNavigation.promise.then(() => lifecycle.updateAppUrl(URL_B));
    firstNavigation.resolve(undefined);
    await flushMicrotasks();

    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-1", URL_A],
      ["stream-1", URL_B],
    ]);
  });

  it("serializes navigation and skips intermediate pending URLs", async () => {
    await startSession("stream-1");
    const firstNavigation = deferred<void>();
    const finalNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(finalNavigation.promise);

    lifecycle.updateAppUrl(URL_A);
    lifecycle.updateAppUrl(URL_B);
    lifecycle.updateAppUrl(URL_C);

    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([["stream-1", URL_A]]);

    firstNavigation.resolve(undefined);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-1", URL_A],
      ["stream-1", URL_C],
    ]);

    finalNavigation.resolve(undefined);
    await flushMicrotasks();
  });

  it("treats a return to the loaded URL as the latest pending request", async () => {
    await startSession("stream-1");
    const firstNavigation = deferred<void>();
    const returnNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(returnNavigation.promise);

    lifecycle.updateAppUrl(URL_A);
    lifecycle.updateAppUrl(BASE_URL);
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([["stream-1", URL_A]]);

    firstNavigation.resolve(undefined);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-1", URL_A],
      ["stream-1", BASE_URL],
    ]);

    returnNavigation.resolve(undefined);
    await flushMicrotasks();
  });

  it("reports a final navigation error and retries the same desired URL", async () => {
    await startSession("stream-1");
    const failedNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(failedNavigation.promise)
      .mockResolvedValueOnce(undefined);

    lifecycle.updateAppUrl(URL_A);
    lifecycle.updateAppUrl(URL_B);
    lifecycle.updateAppUrl(URL_A);
    const failure = new Error("navigation failed");
    failedNavigation.reject(failure);
    await flushMicrotasks();

    expect(mocks.frontendLogWarn).toHaveBeenCalledTimes(1);
    expect(mocks.frontendLogWarn).toHaveBeenCalledWith(
      "previewLifecycle",
      "set_author_preview_url failed",
      expect.objectContaining({ error: failure }),
    );

    lifecycle.updateAppUrl(URL_A);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-1", URL_A],
      ["stream-1", URL_A],
    ]);

    lifecycle.updateAppUrl(URL_A);
    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledTimes(2);
  });

  it("continues to the latest URL when a superseded navigation fails", async () => {
    await startSession("stream-1");
    const failedNavigation = deferred<void>();
    const finalNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(failedNavigation.promise)
      .mockReturnValueOnce(finalNavigation.promise);

    lifecycle.updateAppUrl(URL_A);
    lifecycle.updateAppUrl(URL_C);
    failedNavigation.reject(new Error("superseded navigation failed"));
    await flushMicrotasks();

    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-1", URL_A],
      ["stream-1", URL_C],
    ]);
    expect(mocks.frontendLogWarn).not.toHaveBeenCalledWith(
      "previewLifecycle",
      "set_author_preview_url failed",
      expect.anything(),
    );

    finalNavigation.resolve(undefined);
    await flushMicrotasks();
  });

  it("keeps an old session completion from mutating or clearing the new drain", async () => {
    await startSession("stream-old");
    const oldNavigation = deferred<void>();
    const newNavigation = deferred<void>();
    const latestNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(oldNavigation.promise)
      .mockReturnValueOnce(newNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    lifecycle.updateAppUrl(URL_A);
    await lifecycle.stopPreviewNow("test relaunch");
    await startSession("stream-new", URL_B);
    lifecycle.updateAppUrl(URL_C);

    oldNavigation.resolve(undefined);
    await flushMicrotasks();
    lifecycle.updateAppUrl(URL_A);
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-old", URL_A],
      ["stream-new", URL_C],
    ]);

    newNavigation.resolve(undefined);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([
      ["stream-old", URL_A],
      ["stream-new", URL_C],
      ["stream-new", URL_A],
    ]);

    latestNavigation.resolve(undefined);
    await flushMicrotasks();
    lifecycle.updateAppUrl(URL_A);
    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledTimes(3);
  });

  it("deduplicates a request after the latest URL has loaded", async () => {
    await startSession("stream-1");
    mocks.setAuthorPreviewUrl.mockResolvedValue(undefined);

    lifecycle.updateAppUrl(URL_C);
    await flushMicrotasks();
    lifecycle.updateAppUrl(URL_C);

    expect(mocks.setAuthorPreviewUrl.mock.calls).toEqual([["stream-1", URL_C]]);
  });
});

describe("preview lifecycle recording URL guarantees", () => {
  it("rejects a superseded recording acquisition, releases it, and allows the next one", async () => {
    const releaseEditor = await startSession("stream-1");
    const recordingNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockReturnValueOnce(recordingNavigation.promise)
      .mockResolvedValueOnce(undefined);

    const recording = lifecycle.acquirePreviewForRecording({
      appUrl: URL_A,
      viewport: "desktop",
      reason: "superseded test",
    });
    const rejection = expect(recording).rejects.toThrow(
      "Preview URL or session changed while preparing recording",
    );
    lifecycle.updateAppUrl(URL_C);

    recordingNavigation.resolve(undefined);
    await flushMicrotasks();
    await rejection;

    const validLease = await lifecycle.acquirePreviewForRecording({
      appUrl: URL_C,
      viewport: "desktop",
      reason: "valid retry",
    });
    expect(validLease.streamId).toBe("stream-1");
    validLease.release();

    releaseEditor();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(mocks.stopAuthorPreview).toHaveBeenCalledWith("stream-1");
  });

  it("waits for URL and viewport readiness when recording joins a cold start", async () => {
    const start = deferred<string>();
    const navigation = deferred<void>();
    const viewportUpdate = deferred<void>();
    mocks.startAuthorPreview.mockReturnValueOnce(start.promise);
    mocks.setAuthorPreviewUrl.mockReturnValueOnce(navigation.promise);
    mocks.setAuthorPreviewViewport.mockReturnValueOnce(viewportUpdate.promise);

    const releaseEditor = lifecycle.acquirePreview(BASE_URL, "desktop", vi.fn());
    const recording = lifecycle.acquirePreviewForRecording({
      appUrl: URL_B,
      viewport: { width: 1440, height: 900 },
      reason: "cold-start recording",
    });
    let settled = false;
    void recording.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    start.resolve("stream-1");
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewUrl).toHaveBeenCalledWith("stream-1", URL_B);
    expect(settled).toBe(false);

    navigation.resolve(undefined);
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewViewport).toHaveBeenCalledWith("stream-1", 1440, 900);
    expect(settled).toBe(false);

    viewportUpdate.resolve(undefined);
    const lease = await recording;
    expect(lease.streamId).toBe("stream-1");
    lease.release();
    releaseEditor();
  });

  it("rejects when another URL is queued during the recording viewport update", async () => {
    const releaseEditor = await startSession("stream-1");
    const viewportUpdate = deferred<void>();
    const supersedingNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(supersedingNavigation.promise);
    mocks.setAuthorPreviewViewport.mockReturnValueOnce(viewportUpdate.promise);

    const recording = lifecycle.acquirePreviewForRecording({
      appUrl: URL_A,
      viewport: { width: 1440, height: 900 },
      reason: "viewport superseded test",
    });
    const rejection = expect(recording).rejects.toThrow(
      "Preview URL or session changed while preparing recording",
    );
    await flushMicrotasks();
    expect(mocks.setAuthorPreviewViewport).toHaveBeenCalledWith("stream-1", 1440, 900);

    lifecycle.updateAppUrl(URL_B);
    viewportUpdate.resolve(undefined);
    await flushMicrotasks();
    await rejection;

    supersedingNavigation.resolve(undefined);
    await flushMicrotasks();
    releaseEditor();
  });

  it("rejects when the session changes and permits acquisition on the next session", async () => {
    const releaseOldEditor = await startSession("stream-old");
    const oldNavigation = deferred<void>();
    mocks.setAuthorPreviewUrl.mockReturnValueOnce(oldNavigation.promise);

    const recording = lifecycle.acquirePreviewForRecording({
      appUrl: URL_A,
      viewport: "desktop",
      reason: "session change test",
    });
    const rejection = expect(recording).rejects.toThrow(
      "Preview URL or session changed while preparing recording",
    );

    await lifecycle.stopPreviewNow("replace session");
    releaseOldEditor();
    const releaseNewEditor = await startSession("stream-new", URL_C);
    oldNavigation.resolve(undefined);
    await flushMicrotasks();
    await rejection;

    const validLease = await lifecycle.acquirePreviewForRecording({
      appUrl: URL_C,
      viewport: "desktop",
      reason: "new session",
    });
    expect(validLease.streamId).toBe("stream-new");
    validLease.release();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(mocks.stopAuthorPreview).not.toHaveBeenCalledWith("stream-new");
    releaseNewEditor();
  });
});

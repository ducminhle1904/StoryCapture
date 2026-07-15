import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: { invoke: electronMock.invoke, on: electronMock.on },
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  readonly mimeType: string;
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  timeslice: number | null = null;

  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice ?? null;
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => this.onstop?.());
  }

  pause(): void {
    if (this.state === "recording") this.state = "paused";
  }

  resume(): void {
    if (this.state === "paused") this.state = "recording";
  }

  emit(size: number): void {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(size)], { type: this.mimeType }),
    });
  }
}

interface InvokeEnvelope {
  cmd: string;
  args?: unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadPreload(getUserMedia?: ReturnType<typeof vi.fn>) {
  const stopTrack = vi.fn();
  const getUserMediaMock =
    getUserMedia ??
    vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaMock },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  await import("./preload");
  const internals = electronMock.exposed.get("__TAURI_INTERNALS__") as {
    invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    transformCallback: (callback?: (...args: unknown[]) => void, once?: boolean) => number;
  };
  return { internals, stopTrack };
}

function audioOperations(): Array<Record<string, unknown>> {
  return electronMock.invoke.mock.calls
    .map((call) => call[1] as InvokeEnvelope)
    .filter((envelope) => envelope.cmd === "recording_audio_stream")
    .map((envelope) => envelope.args as Record<string, unknown>);
}

describe("recording preload microphone stream", () => {
  beforeEach(() => {
    process.env.STORYCAPTURE_RECORDING_AV_MODE = "unified";
    vi.resetModules();
    vi.clearAllMocks();
    electronMock.exposed.clear();
    electronMock.listeners.clear();
    FakeMediaRecorder.instances = [];
    electronMock.exposeInMainWorld.mockImplementation((name: string, value: unknown) => {
      electronMock.exposed.set(name, value);
    });
    electronMock.on.mockImplementation(
      (channel: string, listener: (...args: unknown[]) => void) => {
        electronMock.listeners.set(channel, listener);
      },
    );
  });

  afterEach(() => {
    delete process.env.STORYCAPTURE_RECORDING_AV_MODE;
  });

  it("starts mic before the host, streams durable ordered chunks, and drains before stop", async () => {
    const start = deferred<{ id: string }>();
    const commandOrder: string[] = [];
    electronMock.invoke.mockImplementation(async (_channel: string, envelope: InvokeEnvelope) => {
      commandOrder.push(
        envelope.cmd === "recording_audio_stream"
          ? `audio:${String((envelope.args as { operation?: unknown }).operation)}`
          : envelope.cmd,
      );
      if (envelope.cmd === "start_recording") return start.promise;
      if (envelope.cmd === "recording_audio_stream") return { status: "accepted" };
      if (envelope.cmd === "stop_recording") return { output_path: "/take/video.mp4" };
      return null;
    });
    const { internals, stopTrack } = await loadPreload();

    const started = internals.invoke("start_recording", {
      args: { audio_device_id: "default" },
    });
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    expect(FakeMediaRecorder.instances[0]?.timeslice).toBe(1_000);
    expect(commandOrder).toEqual(["start_recording"]);
    start.resolve({ id: "take-1" });
    await started;

    FakeMediaRecorder.instances[0]?.emit(32);
    await vi.waitFor(() =>
      expect(audioOperations().map((item) => item.operation)).toEqual(["begin", "chunk"]),
    );
    await internals.invoke("stop_recording", { session: { id: "take-1" } });

    expect(audioOperations().map((item) => [item.operation, item.sequence])).toEqual([
      ["begin", 0],
      ["chunk", 1],
      ["end", 2],
    ]);
    expect(commandOrder.indexOf("audio:end")).toBeLessThan(commandOrder.indexOf("stop_recording"));
    expect(stopTrack).toHaveBeenCalled();
  });

  it("fails boundedly when more than four chunks queue before host readiness", async () => {
    const start = deferred<{ id: string }>();
    electronMock.invoke.mockImplementation(async (_channel: string, envelope: InvokeEnvelope) => {
      if (envelope.cmd === "start_recording") return start.promise;
      return { status: "accepted" };
    });
    const { internals } = await loadPreload();

    const started = internals.invoke("start_recording", {
      args: { audio_device_id: "default" },
    });
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    const recorder = FakeMediaRecorder.instances[0];
    for (let index = 0; index < 5; index += 1) recorder?.emit(16);
    start.resolve({ id: "take-overflow" });
    await started;

    expect(audioOperations().map((item) => item.operation)).toEqual(["begin", "abort"]);
    expect(audioOperations()[1]?.reason).toBe("audio_backpressure_overflow");
    expect(recorder?.state).toBe("inactive");
  });

  it("honors host pause/resume and automation flush without a renderer stop call", async () => {
    electronMock.invoke.mockImplementation(async (_channel: string, envelope: InvokeEnvelope) => {
      if (envelope.cmd === "start_recording") return { id: "take-automation" };
      return { status: "accepted" };
    });
    const { internals } = await loadPreload();
    await internals.invoke("start_recording", { args: { audio_device_id: "default" } });
    const listener = electronMock.listeners.get("recording-audio-control");
    expect(listener).toBeTypeOf("function");

    listener?.({}, { session_id: "take-automation", action: "pause" });
    await vi.waitFor(() => expect(audioOperations().at(-1)?.operation).toBe("pause"));
    expect(FakeMediaRecorder.instances[0]?.state).toBe("paused");
    listener?.({}, { session_id: "take-automation", action: "resume" });
    await vi.waitFor(() => expect(audioOperations().at(-1)?.operation).toBe("resume"));
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
    listener?.({}, { session_id: "take-automation", action: "flush_and_end" });
    await vi.waitFor(() => expect(audioOperations().at(-1)?.operation).toBe("end"));

    expect(audioOperations().map((item) => item.operation)).toEqual([
      "begin",
      "pause",
      "resume",
      "end",
    ]);
    expect(
      electronMock.invoke.mock.calls.some(
        (call) => (call[1] as InvokeEnvelope).cmd === "stop_recording",
      ),
    ).toBe(false);
  });

  it("preserves requested microphone intent when getUserMedia is unavailable", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error("permission denied"));
    let startPayload: unknown;
    electronMock.invoke.mockImplementation(async (_channel: string, envelope: InvokeEnvelope) => {
      if (envelope.cmd === "start_recording") {
        startPayload = envelope.args;
        return { id: "take-silent" };
      }
      return null;
    });
    const { internals } = await loadPreload(getUserMedia);
    const eventCallback = vi.fn();
    const eventId = internals.transformCallback(eventCallback);

    await internals.invoke("start_recording", {
      args: { audio_device_id: "default" },
      onEvent: { id: eventId },
    });

    expect(startPayload).toMatchObject({
      args: {
        audio_device_id: "default",
        audio_unavailable_reason: "permission denied",
      },
    });
    expect(audioOperations()).toEqual([]);
    expect(eventCallback).not.toHaveBeenCalled();
  });

  it("keeps host-first whole-buffer microphone handoff in legacy mode", async () => {
    process.env.STORYCAPTURE_RECORDING_AV_MODE = "legacy";
    const order: string[] = [];
    const getUserMedia = vi.fn().mockImplementation(async () => {
      order.push("get_user_media");
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    });
    electronMock.invoke.mockImplementation(async (_channel: string, envelope: InvokeEnvelope) => {
      order.push(envelope.cmd);
      if (envelope.cmd === "start_recording") return { id: "take-legacy" };
      if (envelope.cmd === "recording_audio_stream") return { status: "accepted" };
      if (envelope.cmd === "stop_recording") return { output_path: "/take/video.mp4" };
      return null;
    });
    const { internals } = await loadPreload(getUserMedia);

    await internals.invoke("start_recording", { args: { audio_device_id: "default" } });
    expect(order.slice(0, 2)).toEqual(["start_recording", "get_user_media"]);
    expect(FakeMediaRecorder.instances[0]?.timeslice).toBe(250);

    FakeMediaRecorder.instances[0]?.emit(32);
    await internals.invoke("stop_recording", { session: { id: "take-legacy" } });

    expect(order.indexOf("electron_recording_set_audio")).toBeLessThan(
      order.indexOf("stop_recording"),
    );
    expect(audioOperations()).toEqual([]);
  });
});

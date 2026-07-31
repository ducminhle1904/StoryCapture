import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRecordingV4Session } from "./use-recording-v4-session";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  command: vi.fn(),
  subscribe: vi.fn(),
  recalled: vi.fn(),
  remember: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("@/ipc/recording-v4", () => ({
  createRecordingV4: mocks.create,
  commandRecordingV4: mocks.command,
  subscribeRecordingV4: mocks.subscribe,
  recalledRecordingV4Session: mocks.recalled,
  rememberRecordingV4Session: mocks.remember,
  forgetRecordingV4Session: mocks.forget,
  recordRecordingV4Action: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recalled.mockReturnValue(null);
  mocks.command.mockResolvedValue(null);
});

describe("useRecordingV4Session", () => {
  it("detaches on unmount without issuing stop or cancel", async () => {
    const channel = { onmessage: vi.fn() };
    mocks.create.mockResolvedValue({ session: { id: "session-1" }, channel });
    const { result, unmount } = renderHook(() => useRecordingV4Session("/project", { onEvent: vi.fn() }));
    await act(() => result.current.start({
      project_path: "/project", source_url: "https://example.test", logical_width: 960,
      logical_height: 540, requested_audio_roles: [], include_cursor: false,
    }));
    unmount();
    expect(channel.onmessage).toBeNull();
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(mocks.command).toHaveBeenCalledWith({ id: "session-1" }, "start");
  });

  it("reattaches the remembered host session after a renderer reload", async () => {
    const channel = { onmessage: vi.fn() };
    mocks.recalled.mockReturnValue({ id: "session-existing" });
    mocks.subscribe.mockResolvedValue({ channel, snapshot: {
      version: 4, session_id: "session-existing", state: "capturing", revision: 3,
      active_media_time_us: 10, requested_audio_roles: ["microphone"], cadence: null,
      terminal_result: null,
    } });
    const onEvent = vi.fn();
    renderHook(() => useRecordingV4Session("/project", { onEvent }));
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot" })));
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("keeps the remembered host session attached when subscription fails", async () => {
    mocks.recalled.mockReturnValue({ id: "session-existing" });
    mocks.subscribe.mockRejectedValue(new Error("channel unavailable"));
    const onReattached = vi.fn();
    const onReattachError = vi.fn();
    const { result } = renderHook(() => useRecordingV4Session("/project", {
      onEvent: vi.fn(), onReattached, onReattachError,
    }));
    await waitFor(() => expect(onReattachError).toHaveBeenCalled());
    expect(onReattached).toHaveBeenCalledWith("session-existing");
    expect(result.current.sessionIdRef.current).toBe("session-existing");
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it("returns no active session when start fails closed with a terminal result", async () => {
    const channel = { onmessage: vi.fn() };
    const terminal = {
      version: 4, session_id: "session-1", state: "failed", failure_codes: ["preflight_failed"],
      published_recording: null, diagnostic_bundle_path: "/tmp/diagnostics", evidence: null,
    };
    mocks.create.mockResolvedValue({ session: { id: "session-1" }, channel });
    mocks.command.mockResolvedValue(terminal);
    const onEvent = vi.fn();
    const { result } = renderHook(() => useRecordingV4Session("/project", { onEvent }));
    let started: string | null = "unexpected";
    await act(async () => {
      started = await result.current.start({
        project_path: "/project", source_url: "https://example.test", logical_width: 960,
        logical_height: 540, requested_audio_roles: [], include_cursor: false,
      });
    });
    expect(started).toBeNull();
    expect(onEvent).toHaveBeenCalledWith({ type: "terminal", result: terminal });
    expect(mocks.forget).toHaveBeenCalledWith("/project", "session-1");
  });
});

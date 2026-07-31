import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRecordingV4,
  forgetRecordingV4Session,
  recalledRecordingV4Session,
  rememberRecordingV4Session,
  subscribeRecordingV4,
} from "./recording-v4";

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: ((event: T) => void) | null = null;
  }
  return { Channel, invoke: vi.fn() };
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => vi.mocked(invoke).mockReset());

describe("Recording V4 renderer facade", () => {
  it("creates a session with a detachable event channel", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ id: "session-1" });
    const onEvent = vi.fn();
    const result = await createRecordingV4({
      project_path: "/project",
      source_url: "https://example.test",
      logical_width: 960,
      logical_height: 540,
      requested_audio_roles: ["microphone"],
      include_cursor: false,
    }, onEvent);

    expect(result.session).toEqual({ id: "session-1" });
    const payload = vi.mocked(invoke).mock.calls[0]?.[1] as { onEvent: { onmessage: typeof onEvent } };
    payload.onEvent.onmessage({ type: "heartbeat", revision: 1, monotonic_us: 2 });
    expect(onEvent).toHaveBeenCalledOnce();
    result.channel.onmessage = null;
    expect(payload.onEvent.onmessage).toBeNull();
  });

  it("subscribes an existing session without issuing a lifecycle command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ version: 4, session_id: "session-1", state: "capturing" });
    const subscription = await subscribeRecordingV4({ id: "session-1" }, vi.fn());
    expect(subscription.snapshot?.state).toBe("capturing");
    expect(invoke).toHaveBeenCalledWith("recording_v4_subscribe", expect.objectContaining({
      session: { id: "session-1" },
    }));
  });

  it("remembers one host-owned session per project and removes only the expected one", () => {
    const storage = new MemoryStorage();
    rememberRecordingV4Session("/project", "session-1", storage);
    expect(recalledRecordingV4Session("/project", storage)).toEqual({ id: "session-1" });
    forgetRecordingV4Session("/project", "other", storage);
    expect(recalledRecordingV4Session("/project", storage)).toEqual({ id: "session-1" });
    forgetRecordingV4Session("/project", "session-1", storage);
    expect(recalledRecordingV4Session("/project", storage)).toBeNull();
  });
});

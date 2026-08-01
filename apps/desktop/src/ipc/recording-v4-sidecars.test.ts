import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTextFile } = vi.hoisted(() => ({ readTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile }));

import { fetchRecordingV4Sidecars } from "./recording-v4-sidecars";

const actions = {
  version: 4,
  session_id: "session-v4",
  clock: "active_media_time_us",
  events: [],
};
const cursor = {
  version: 4,
  session_id: "session-v4",
  clock: "active_media_time_us",
  geometry: {
    coordinate_width: 1280,
    coordinate_height: 720,
    capture_width: 1920,
    capture_height: 1080,
  },
  samples: [],
};

describe("Recording V4 post-production sidecar reader", () => {
  beforeEach(() => readTextFile.mockReset());

  it("uses the shared strict readers and requires matching sessions", async () => {
    readTextFile
      .mockResolvedValueOnce(JSON.stringify(actions))
      .mockResolvedValueOnce(JSON.stringify(cursor));

    await expect(
      fetchRecordingV4Sidecars("/bundle/actions.json", "/bundle/cursor.json"),
    ).resolves.toEqual({ actions, cursor });
  });

  it("rejects malformed and cross-session sidecars", async () => {
    readTextFile
      .mockResolvedValueOnce(JSON.stringify(actions))
      .mockResolvedValueOnce(JSON.stringify({ ...cursor, session_id: "other" }));
    await expect(
      fetchRecordingV4Sidecars("/bundle/actions.json", "/bundle/cursor.json"),
    ).rejects.toThrow("different sessions");

    readTextFile
      .mockResolvedValueOnce(JSON.stringify(actions))
      .mockResolvedValueOnce(JSON.stringify({ ...cursor, version: 3 }));
    await expect(
      fetchRecordingV4Sidecars("/bundle/actions.json", "/bundle/cursor.json"),
    ).rejects.toThrow("invalid Recording V4 cursor sidecar");
  });
});

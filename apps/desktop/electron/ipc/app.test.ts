import { describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/tmp/storycapture-user-data"),
  getVersion: vi.fn(() => "0.0.0-test"),
}));

vi.mock("electron", () => ({
  app: electronMock,
}));

import { appHandlers } from "./app";

describe("app IPC handlers", () => {
  it("handles ping", () => {
    expect(appHandlers.ping()).toBe("pong from storycapture");
  });

  it("returns app info using the shared session id", () => {
    expect(appHandlers.app_info()).toMatchObject({
      version: "0.0.0-test",
      platform: process.platform,
      arch: process.arch,
      data_dir: "/tmp/storycapture-user-data",
      log_dir: "/tmp/storycapture-user-data/logs",
      pid: process.pid,
    });
    expect(String(appHandlers.app_info().session_id)).toHaveLength(36);
  });

  it("parses story source with the existing parser", () => {
    expect(
      appHandlers.parse_story({
        source: 'story "Demo" {\nscene "Main" {\n  click "Continue"\n}\n}',
      }),
    ).toMatchObject({
      ast: {
        name: "Demo",
        scenes: [{ name: "Main" }],
      },
      diagnostics: [],
    });
    expect(appHandlers.parse_story({})).toEqual({ ast: null, diagnostics: [] });
  });

  it("throws the existing panic error", () => {
    expect(() => appHandlers.trigger_panic()).toThrow(
      "trigger_panic requested",
    );
  });
});

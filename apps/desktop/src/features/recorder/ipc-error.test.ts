import { describe, expect, it } from "vitest";

import { formatIpcError } from "./ipc-error";

describe("formatIpcError", () => {
  it("removes only the Electron compatibility bridge envelope", () => {
    expect(
      formatIpcError(
        new Error(
          "Error invoking remote method 'tauri-invoke': Error: Recording encoder could not start (ENOTDIR)",
        ),
      ),
    ).toBe("Recording encoder could not start (ENOTDIR)");
  });

  it("preserves typed IPC errors", () => {
    expect(formatIpcError({ kind: "NotFound", message: "Recording session was not found" })).toBe(
      "NotFound: Recording session was not found",
    );
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatIpcError(new Error("Network unavailable"))).toBe("Network unavailable");
    expect(formatIpcError(null)).toBe("Unknown error");
  });
});

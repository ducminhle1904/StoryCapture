import { describe, expect, it } from "vitest";
import {
  CaptureBackendContractError,
  type CaptureSourceCandidate,
  normalizeWindowTitle,
  resolveCaptureSource,
} from "./capture-backend";

const candidates: CaptureSourceCandidate[] = [
  {
    source_id: "window:101:0",
    native_window_id: "101",
    display_id: null,
    owner_pid: 42,
    title: "  Demo   Window ",
  },
  {
    source_id: "window:202:0",
    native_window_id: 202,
    display_id: null,
    owner_pid: 84,
    title: "Other",
  },
];

describe("capture source resolver", () => {
  it("resolves exact native window ID independent of enumeration order", () => {
    const target = { kind: "window" as const, window_id: "0101" };
    expect(resolveCaptureSource(target, candidates).source_id).toBe("window:101:0");
    expect(resolveCaptureSource(target, [...candidates].reverse()).source_id).toBe("window:101:0");
  });

  it("requires positive PID and exact normalized title", () => {
    expect(
      resolveCaptureSource(
        { kind: "window_by_pid", pid: 42, title_hint: "Ｄｅｍｏ window" },
        candidates,
      ).source_id,
    ).toBe("window:101:0");
    expect(() =>
      resolveCaptureSource({ kind: "window_by_pid", pid: 42, title_hint: "Demo" }, candidates),
    ).toThrow("not found");
    expect(() =>
      resolveCaptureSource({ kind: "window_by_pid", pid: 0, title_hint: "Demo" }, candidates),
    ).toThrow("invalid");
  });

  it("fails typed when PID metadata is unavailable", () => {
    try {
      resolveCaptureSource(
        { kind: "window_by_pid", pid: 42, title_hint: "Demo Window" },
        candidates.map((candidate) => ({ ...candidate, owner_pid: null })),
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureBackendContractError);
      expect((error as CaptureBackendContractError).reason).toBe("pid_resolution_unsupported");
    }
  });

  it("rejects ambiguous IDs and unsafe title hints", () => {
    expect(() =>
      resolveCaptureSource({ kind: "window", window_id: 101 }, [candidates[0], candidates[0]]),
    ).toThrow("ambiguous");
    expect(() => normalizeWindowTitle("bad\u0000title")).toThrow("invalid");
  });
});

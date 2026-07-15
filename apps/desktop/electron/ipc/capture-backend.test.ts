import { describe, expect, it, vi } from "vitest";
import {
  type CaptureBackend,
  type CaptureBackendCapabilities,
  CaptureBackendRegistry,
  type CaptureBackendRequest,
  captureBackendMode,
  createCaptureBackendRequest,
  resolveCaptureBackend,
} from "./capture-backend";

function backend(input: {
  id: string;
  native?: boolean;
  targetClasses: CaptureBackendCapabilities["target_classes"];
  supported?: boolean;
}): CaptureBackend & { probe: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } {
  const probe = vi.fn(async () => ({
    supported: input.supported ?? true,
    reason: input.supported === false ? ("probe_failed" as const) : null,
    delivery_mode: input.supported === false ? null : ("host_frames" as const),
    platform_version: "test",
  }));
  const start = vi.fn();
  return {
    id: input.id,
    capabilities: () => ({
      contract_version: 1,
      backend_id: input.id,
      target_classes: input.targetClasses,
      delivery_modes: ["host_frames"],
      pixel_formats: ["bgra"],
      timestamp_source: "recording_media_clock",
      cursor_control: "selectable",
      supports_pause: true,
      supports_dynamic_resize: false,
      native: input.native ?? false,
    }),
    probe,
    start,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
}

function request(target: CaptureBackendRequest["target"]): CaptureBackendRequest {
  return createCaptureBackendRequest({
    target,
    width: 1280,
    height: 720,
    fps: 30,
    includeCursor: false,
  });
}

describe("capture backend routing", () => {
  it("fails closed to legacy for invalid rollout values", () => {
    expect(captureBackendMode("native_everywhere")).toBe("legacy");
  });

  it("never probes or starts native for author_preview", async () => {
    const registry = new CaptureBackendRegistry();
    const electron = backend({ id: "electron_author_preview", targetClasses: ["browser_surface"] });
    const native = backend({
      id: "macos_native_external",
      native: true,
      targetClasses: ["external_window", "display"],
    });
    registry.register(electron);
    registry.register(native);
    const resolved = await resolveCaptureBackend({
      registry,
      request: request({ kind: "author_preview", stream_id: "preview-1" }),
      mode: "contract_ga",
      preferredNativeBackendId: native.id,
    });
    expect(resolved.backend.id).toBe("electron_author_preview");
    expect(native.probe).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
  });

  it("records a pre-start native fallback without changing the target", async () => {
    const registry = new CaptureBackendRegistry();
    const electron = backend({
      id: "electron_external",
      targetClasses: ["external_window", "display"],
    });
    const native = backend({
      id: "macos_native_external",
      native: true,
      targetClasses: ["external_window", "display"],
      supported: false,
    });
    registry.register(electron);
    registry.register(native);
    const resolved = await resolveCaptureBackend({
      registry,
      request: request({ kind: "display", display_id: 1 }),
      mode: "contract_shadow",
      preferredNativeBackendId: native.id,
    });
    expect(resolved.provenance).toMatchObject({
      selected_backend_id: "electron_external",
      attempted_backend_id: "macos_native_external",
      fallback_reason: "probe_failed",
      resolved_target_identity: "display:1",
    });
  });

  it("falls back before start when the preferred native backend is not registered", async () => {
    const registry = new CaptureBackendRegistry();
    registry.register(
      backend({
        id: "electron_external",
        targetClasses: ["external_window", "display"],
      }),
    );

    const resolved = await resolveCaptureBackend({
      registry,
      request: request({ kind: "display", display_id: 1 }),
      mode: "contract_shadow",
      preferredNativeBackendId: "macos_native_external",
    });

    expect(resolved.provenance).toMatchObject({
      selected_backend_id: "electron_external",
      attempted_backend_id: "macos_native_external",
      fallback_reason: "backend_not_registered",
    });
  });

  it("rejects native browser-surface capability at registration", () => {
    const registry = new CaptureBackendRegistry();
    expect(() =>
      registry.register(
        backend({ id: "unsafe_native", native: true, targetClasses: ["browser_surface"] }),
      ),
    ).toThrow("cannot advertise browser_surface");
  });
});

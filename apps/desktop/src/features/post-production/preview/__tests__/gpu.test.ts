import { afterEach, describe, expect, it, vi } from "vitest";
import { initPreviewContext } from "../gpu";

function makeCanvas(
  getContext: (id: string) => unknown,
): HTMLCanvasElement {
  return { getContext } as unknown as HTMLCanvasElement;
}

function stubNavigator(gpu: unknown): void {
  vi.stubGlobal("navigator", {
    ...(globalThis.navigator ?? {}),
    gpu,
  } as unknown as Navigator);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("initPreviewContext", () => {
  it("gpu_webgpu_happy_path: returns webgpu ctx when navigator.gpu and adapter available", async () => {
    const device = { __kind: "device" } as unknown as GPUDevice;
    const adapter = {
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;
    const context = {
      configure: vi.fn(),
    } as unknown as GPUCanvasContext;

    stubNavigator({
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: () => "bgra8unorm" as GPUTextureFormat,
    });

    const canvas = makeCanvas((id) => (id === "webgpu" ? context : null));

    const ctx = await initPreviewContext(canvas);
    expect(ctx.kind).toBe("webgpu");
    if (ctx.kind !== "webgpu") throw new Error("unreachable");
    expect(ctx.device).toBe(device);
    expect(ctx.context).toBe(context);
    expect(ctx.format).toBe("bgra8unorm");
    expect(ctx.adapter).toBe(adapter);
    expect(context.configure).toHaveBeenCalledOnce();
  });

  it("gpu_no_webgpu_falls_back: returns webgl2 when navigator.gpu undefined", async () => {
    stubNavigator(undefined);

    const gl = { __kind: "gl2" } as unknown as WebGL2RenderingContext;
    const canvas = makeCanvas((id) => (id === "webgl2" ? gl : null));

    const ctx = await initPreviewContext(canvas);
    expect(ctx.kind).toBe("webgl2");
    if (ctx.kind !== "webgl2") throw new Error("unreachable");
    expect(ctx.gl).toBe(gl);
  });

  it("gpu_adapter_null_falls_back: when requestAdapter returns null, falls back to webgl2", async () => {
    stubNavigator({
      requestAdapter: vi.fn(async () => null),
      getPreferredCanvasFormat: () => "bgra8unorm",
    });

    const gl = { __kind: "gl2-fallback" } as unknown as WebGL2RenderingContext;
    const canvas = makeCanvas((id) => (id === "webgl2" ? gl : null));

    const ctx = await initPreviewContext(canvas);
    expect(ctx.kind).toBe("webgl2");
  });

  it("gpu_no_backends_throws: throws when neither backend available", async () => {
    stubNavigator(undefined);

    const canvas = makeCanvas(() => null);

    await expect(initPreviewContext(canvas)).rejects.toThrow(
      /preview unsupported/i,
    );
  });

  it("gpu_webgpu_context_missing_falls_back_to_webgl2", async () => {
    const adapter = {
      requestDevice: vi.fn(async () => ({}) as GPUDevice),
    } as unknown as GPUAdapter;

    stubNavigator({
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: () => "bgra8unorm",
    });

    const gl = {} as WebGL2RenderingContext;
    const canvas = makeCanvas((id) => {
      if (id === "webgpu") return null; // reject webgpu context
      if (id === "webgl2") return gl;
      return null;
    });

    const ctx = await initPreviewContext(canvas);
    expect(ctx.kind).toBe("webgl2");
  });
});

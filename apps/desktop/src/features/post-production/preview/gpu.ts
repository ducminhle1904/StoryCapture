/// <reference types="@webgpu/types" />

/**
 * Preview GPU context: WebGPU-primary with WebGL2 fallback.
 *
 * Feature-detects WebGPU at runtime — when `navigator.gpu` is missing,
 * the adapter is null, or the canvas rejects `getContext('webgpu')`, we
 * transparently fall back to WebGL2. VideoFrame lifecycle is handled by
 * the companion `video-frame-lifecycle` helper; this module owns only
 * the context selection.
 */

import { frontendLog } from "@/lib/log";

export type PreviewBackend = "webgpu" | "webgl2";

export type PreviewCtx =
  | {
      kind: "webgpu";
      device: GPUDevice;
      context: GPUCanvasContext;
      format: GPUTextureFormat;
      adapter: GPUAdapter;
    }
  | {
      kind: "webgl2";
      gl: WebGL2RenderingContext;
    };

export async function initPreviewContext(canvas: HTMLCanvasElement): Promise<PreviewCtx> {
  if (typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (context) {
          const format = navigator.gpu.getPreferredCanvasFormat();
          context.configure({ device, format, alphaMode: "premultiplied" });
          frontendLog.info("preview/gpu", "using WebGPU backend", {
            fields: {
              format,
              adapter_features: Array.from(adapter.features),
            },
          });
          return { kind: "webgpu", device, context, format, adapter };
        }
      }
    } catch (err) {
      // WebGPU present but adapter/device request failed — fall through to WebGL2.
      frontendLog.warn("preview/gpu", "WebGPU init failed; falling back to WebGL2", { error: err });
    }
  }

  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (gl) {
    frontendLog.info("preview/gpu", "using WebGL2 fallback backend");
    return { kind: "webgl2", gl };
  }

  throw new Error("Neither WebGPU nor WebGL2 available — preview unsupported");
}

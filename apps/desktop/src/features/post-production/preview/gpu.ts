/// <reference types="@webgpu/types" />

/**
 * Preview GPU context: WebGPU-primary with WebGL2 fallback.
 *
 * Pitfall #4 mitigation (D-01): feature-detect WebGPU at runtime. When
 * `navigator.gpu` is missing, the adapter is null, or the canvas rejects
 * `getContext('webgpu')`, we transparently fall back to WebGL2. Pitfall #5
 * (VideoFrame leak) is addressed by the companion `video-frame-lifecycle`
 * helper; this module owns only the context selection.
 */

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

export async function initPreviewContext(
  canvas: HTMLCanvasElement,
): Promise<PreviewCtx> {
  if (typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        const context = canvas.getContext(
          "webgpu",
        ) as GPUCanvasContext | null;
        if (context) {
          const format = navigator.gpu.getPreferredCanvasFormat();
          context.configure({ device, format, alphaMode: "premultiplied" });
          // eslint-disable-next-line no-console
          console.info("[preview] using WebGPU");
          return { kind: "webgpu", device, context, format, adapter };
        }
      }
    } catch (err) {
      // WebGPU present but adapter/device request failed — fall through to WebGL2.
      // eslint-disable-next-line no-console
      console.warn("[preview] WebGPU init failed, falling back", err);
    }
  }

  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (gl) {
    // eslint-disable-next-line no-console
    console.info("[preview] using WebGL2 fallback");
    return { kind: "webgl2", gl };
  }

  throw new Error(
    "Neither WebGPU nor WebGL2 available — preview unsupported",
  );
}

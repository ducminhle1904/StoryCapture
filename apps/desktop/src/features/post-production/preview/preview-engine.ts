/**
 * PreviewEngine — WebGPU-primary / WebGL2-fallback compositor owner.
 *
 * Design decision D-33: the engine owns the GPU context lifecycle end-to-end.
 * React components (wired in Plan 02-12) call `init()` in a useEffect and
 * `dispose()` in its cleanup; the engine survives webview reloads because it
 * re-initialises on mount. Consumers never need to know which backend is
 * active — `backend` getter exposes it only for telemetry/DevTools.
 *
 * PreviewRenderPlan field consumption map:
 *   output_width / output_height -> FrameUniforms.output_size
 *   fps                           -> host-side scheduling (not read here)
 *   zoom_matrices                 -> FrameUniforms.zoom (Plan 05 interpolates)
 *   cursor_atlas_ref              -> FrameUniforms.has_cursor + cursor atlas (Plan 06)
 *   ripples                       -> RippleGpu storage / uniform arrays (Plan 09)
 *   text_boxes                    -> drawtext in final emit (Plan 07) — NOT read here
 *   background                    -> BackgroundUniforms (Plan 11)
 */
import { initPreviewContext, type PreviewBackend, type PreviewCtx } from "./gpu";
import type { PreviewRenderPlan } from "./types";
import { WebGPUBackend } from "./webgpu-context";
import { WebGL2Backend } from "./webgl2-context";

export interface PreviewEngineConfig {
  canvas: HTMLCanvasElement;
  videoElement: HTMLVideoElement;
  outputWidth: number;
  outputHeight: number;
}

interface Backend {
  init(): Promise<void>;
  renderFrame(t_ms: number, plan: PreviewRenderPlan): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export class PreviewEngine {
  private ctx: PreviewCtx | null = null;
  private backendImpl: Backend | null = null;

  constructor(private readonly config: PreviewEngineConfig) {}

  async init(): Promise<void> {
    this.ctx = await initPreviewContext(this.config.canvas);
    if (this.ctx.kind === "webgpu") {
      this.backendImpl = new WebGPUBackend(
        this.ctx.device,
        this.ctx.context,
        this.ctx.format,
        this.config,
      );
    } else {
      this.backendImpl = new WebGL2Backend(this.ctx.gl, this.config);
    }
    await this.backendImpl.init();
  }

  async renderFrame(t_ms: number, plan: PreviewRenderPlan): Promise<void> {
    if (!this.backendImpl) {
      throw new Error("PreviewEngine not initialised — call init() first");
    }
    this.backendImpl.renderFrame(t_ms, plan);
  }

  /**
   * Propagate a canvas resize to the active backend. Called by the host
   * hook (`usePreview`) on `ResizeObserver` ticks. Safe to call before
   * `init()` resolves — becomes a no-op.
   */
  resize(width: number, height: number): void {
    this.backendImpl?.resize(width, height);
  }

  dispose(): void {
    this.backendImpl?.dispose();
    this.backendImpl = null;
    this.ctx = null;
  }

  get backend(): PreviewBackend {
    return this.ctx?.kind ?? "webgl2";
  }
}

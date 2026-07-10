/**
 * PreviewEngine owns the compositor backend lifecycle.
 */
import { initPreviewContext, type PreviewBackend, type PreviewCtx } from "./gpu";
import type { PreviewRenderPlan } from "./types";
import { WebGL2Backend } from "./webgl2-context";
import { WebGPUBackend } from "./webgpu-context";

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

  /** Propagate a canvas resize to the active backend. */
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

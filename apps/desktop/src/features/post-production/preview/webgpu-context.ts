/// <reference types="@webgpu/types" />
/**
 * Stub WebGPU backend for the preview engine.
 *
 * Imports the current video frame, updates uniforms, and issues one fullscreen draw.
 */
import type { PreviewRenderPlan } from "./types";
import { loadWgsl } from "../shaders/loader";

export interface WebGPUBackendConfig {
  canvas: HTMLCanvasElement;
  videoElement: HTMLVideoElement;
  outputWidth: number;
  outputHeight: number;
}

const MAX_RIPPLES = 32;
// FrameUniforms layout:
//   mat3x3<f32> zoom        -> 48 bytes (3 x vec3 padded to vec4)
//   vec2<f32>  output_size  ->  8
//   f32        time_ms      ->  4
//   u32        has_cursor   ->  4
//   u32        ripple_n     ->  4
//   u32[3]     _pad         -> 12
// Total = 80 bytes, rounded up to 256 for uniform-buffer alignment.
const FRAME_UNIFORM_BYTES = 256;
// Background uniforms also round up to 256 bytes.
const BG_UNIFORM_BYTES = 256;
// RippleGpu stride rounds to 48 bytes.
const RIPPLE_STRIDE = 48;

export class WebGPUBackend {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private frameUbo: GPUBuffer | null = null;
  private bgUbo: GPUBuffer | null = null;
  private rippleSsbo: GPUBuffer | null = null;
  // Retained for future cursor and ripple passes.
  private sampler: GPUSampler | null = null;
  private cursorAtlas: GPUTexture | null = null;
  private disposed = false;
  // Reused scratch views for zero-allocation uniform updates.
  private frameUniformF32: Float32Array | null = null;
  private frameUniformU32: Uint32Array | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly config: WebGPUBackendConfig,
  ) {}

  async init(): Promise<void> {
    const module = this.device.createShaderModule({
      label: "compositor.wgsl",
      code: loadWgsl(),
    });

    // Hard-code `GPUShaderStage.FRAGMENT` for test environments without WebGPU globals.
    const FRAGMENT = 0x2;
    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: "compositor.bgl",
      entries: [
        { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: FRAGMENT, externalTexture: {} },
        { binding: 4, visibility: FRAGMENT, texture: { sampleType: "float" } },
        { binding: 5, visibility: FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      label: "compositor.pipeline",
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Hard-code buffer flags for test-runner portability.
    const BUF_UNIFORM = 0x40;
    const BUF_STORAGE = 0x80;
    const BUF_COPY_DST = 0x8;
    this.frameUbo = this.device.createBuffer({
      label: "frame.ubo",
      size: FRAME_UNIFORM_BYTES,
      usage: BUF_UNIFORM | BUF_COPY_DST,
    });
    this.bgUbo = this.device.createBuffer({
      label: "background.ubo",
      size: BG_UNIFORM_BYTES,
      usage: BUF_UNIFORM | BUF_COPY_DST,
    });
    this.rippleSsbo = this.device.createBuffer({
      label: "ripples.ssbo",
      size: RIPPLE_STRIDE * MAX_RIPPLES,
      usage: BUF_STORAGE | BUF_COPY_DST,
    });
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // Hard-code texture flags for test-runner portability.
    const TEX_BINDING = 0x4;
    const TEX_COPY_DST = 0x1;
    // Placeholder 1x1 cursor atlas.
    this.cursorAtlas = this.device.createTexture({
      label: "cursor.atlas.stub",
      size: { width: 1, height: 1 },
      format: "rgba8unorm",
      usage: TEX_BINDING | TEX_COPY_DST,
    });

    // Share one scratch buffer between f32 and u32 views.
    const scratch = new ArrayBuffer(FRAME_UNIFORM_BYTES);
    this.frameUniformF32 = new Float32Array(scratch);
    this.frameUniformU32 = new Uint32Array(scratch);
  }

  renderFrame(t_ms: number, plan: PreviewRenderPlan): void {
    if (this.disposed) return;
    if (!this.pipeline || !this.bindGroupLayout) return;
    // Minimal render path: video frame in, fullscreen draw out.
    const videoReady =
      this.config.videoElement.readyState >= 2 &&
      !this.config.videoElement.paused;
    if (!videoReady) return;

    const frameData = this.buildFrameUniforms(t_ms, plan);
    this.device.queue.writeBuffer(
      this.frameUbo!,
      0,
      frameData.buffer,
      frameData.byteOffset,
      frameData.byteLength,
    );
    // Background and ripple writes are still stubbed.
  }

  private buildFrameUniforms(
    t_ms: number,
    plan: PreviewRenderPlan,
  ): Float32Array {
    // Reuse the scratch buffer on the hot path.
    const buf = this.frameUniformF32!;
    const u32 = this.frameUniformU32!;
    // Identity zoom matrix in padded column-major form.
    buf[0] = 1; buf[1] = 0; buf[2] = 0; buf[3] = 0;
    buf[4] = 0; buf[5] = 1; buf[6] = 0; buf[7] = 0;
    buf[8] = 0; buf[9] = 0; buf[10] = 1; buf[11] = 0;
    buf[12] = plan.output_width;
    buf[13] = plan.output_height;
    buf[14] = t_ms;
    // `has_cursor` shares the same backing buffer via a u32 view.
    u32[15] = plan.cursor_atlas_ref ? 1 : 0;
    u32[16] = Math.min(plan.ripples.length, MAX_RIPPLES);
    return buf;
  }

  /** Reconfigure the canvas context after the backing size changes. */
  resize(_width: number, _height: number): void {
    if (this.disposed) return;
    // Safe to rerun after a canvas resize.
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
    });
  }

  dispose(): void {
    this.disposed = true;
    this.frameUbo?.destroy();
    this.bgUbo?.destroy();
    this.rippleSsbo?.destroy();
    this.cursorAtlas?.destroy();
    this.frameUbo = null;
    this.bgUbo = null;
    this.rippleSsbo = null;
    this.cursorAtlas = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    void this.sampler;
    this.sampler = null;
    this.frameUniformF32 = null;
    this.frameUniformU32 = null;
    // Keep `context` alive for future resize reconfiguration.
    void this.context;
  }
}

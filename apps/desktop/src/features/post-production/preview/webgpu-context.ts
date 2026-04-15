/// <reference types="@webgpu/types" />
/**
 * WebGPU backend for the PreviewEngine (stub).
 *
 * Owns the render pipeline, bind group layout, uniform buffer, ripple storage
 * buffer, sampler, and cursor atlas texture. Each renderFrame() tick:
 *   1. Imports the current VideoFrame as a GPUExternalTexture (zero-copy).
 *   2. Updates the FrameUniforms (zoom matrix, time, ripple count) and the
 *      ripple storage buffer from the incoming PreviewRenderPlan.
 *   3. Issues a single fullscreen draw.
 *
 * This plan only wires the plumbing — actual per-feature uniform math (zoom
 * easing, cursor atlas sampling, text overlays) lands in Plans 05–10.
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
// FrameUniforms layout (std140-ish, WGSL std rules):
//   mat3x3<f32> zoom        -> 48 bytes (3 x vec3 padded to vec4)
//   vec2<f32>  output_size  ->  8
//   f32        time_ms      ->  4
//   u32        has_cursor   ->  4
//   u32        ripple_n     ->  4
//   u32[3]     _pad         -> 12
// Total -> 80 bytes. Round up to 256-byte alignment for uniform buffer.
const FRAME_UNIFORM_BYTES = 256;
// BackgroundUniforms: 2 x vec4 + u32 + pad = 48 bytes -> 256 aligned.
const BG_UNIFORM_BYTES = 256;
// RippleGpu stride: vec2 + 4x f32 + vec4 = 40 bytes, WGSL rounds to 48.
const RIPPLE_STRIDE = 48;

export class WebGPUBackend {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private frameUbo: GPUBuffer | null = null;
  private bgUbo: GPUBuffer | null = null;
  private rippleSsbo: GPUBuffer | null = null;
  // Sampler + cursor atlas held here for Plans 06 (cursor) + 09 (ripples) to
  // bind at draw time; intentionally unread in this bootstrap plan.
  private sampler: GPUSampler | null = null;
  private cursorAtlas: GPUTexture | null = null;
  private disposed = false;

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

    // GPUShaderStage.FRAGMENT = 0x2. Hard-coded so the module loads under
    // test runners (happy-dom) that don't inject the WebGPU globals.
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

    // GPUBufferUsage flags — hard-coded for test-runner portability:
    //   UNIFORM=0x40, STORAGE=0x80, COPY_DST=0x8
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
    // GPUTextureUsage: TEXTURE_BINDING=0x4, COPY_DST=0x1
    const TEX_BINDING = 0x4;
    const TEX_COPY_DST = 0x1;
    // Placeholder 1x1 cursor atlas — Plan 06 replaces with PNG sequence atlas.
    this.cursorAtlas = this.device.createTexture({
      label: "cursor.atlas.stub",
      size: { width: 1, height: 1 },
      format: "rgba8unorm",
      usage: TEX_BINDING | TEX_COPY_DST,
    });
  }

  renderFrame(t_ms: number, plan: PreviewRenderPlan): void {
    if (this.disposed) return;
    if (!this.pipeline || !this.bindGroupLayout) return;
    // Stub render path: import video frame if available, build uniforms, draw.
    // Plans 05–10 fill in the per-feature logic.
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
    // Background + ripple buffer writes elided in stub; Plans 09/11 wire.
  }

  private buildFrameUniforms(
    t_ms: number,
    plan: PreviewRenderPlan,
  ): Float32Array {
    const buf = new Float32Array(FRAME_UNIFORM_BYTES / 4);
    // Identity zoom in 3x4 column-major with vec3 -> vec4 padding.
    // col0
    buf[0] = 1; buf[1] = 0; buf[2] = 0;
    // col1
    buf[4] = 0; buf[5] = 1; buf[6] = 0;
    // col2
    buf[8] = 0; buf[9] = 0; buf[10] = 1;
    buf[12] = plan.output_width;
    buf[13] = plan.output_height;
    buf[14] = t_ms;
    // has_cursor as u32 written via DataView view of the same ArrayBuffer
    const u32 = new Uint32Array(buf.buffer);
    u32[15] = plan.cursor_atlas_ref ? 1 : 0;
    u32[16] = Math.min(plan.ripples.length, MAX_RIPPLES);
    return buf;
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
    // `context` is retained for future re-configure (e.g. size change); mark read.
    void this.context;
  }
}

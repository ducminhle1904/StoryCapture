import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewEngine } from "../preview-engine";
import type { PreviewRenderPlan } from "../types";

// happy-dom does not implement WebGPU nor full WebGL2; we stub both backends.

function stubNavigator(gpu: unknown): void {
  vi.stubGlobal("navigator", {
    ...(globalThis.navigator ?? {}),
    gpu,
  } as unknown as Navigator);
}

function makeCanvas(getContext: (id: string) => unknown): HTMLCanvasElement {
  return { getContext } as unknown as HTMLCanvasElement;
}

function makeVideo(): HTMLVideoElement {
  return {
    readyState: 0,
    paused: true,
    videoWidth: 0,
    videoHeight: 0,
  } as unknown as HTMLVideoElement;
}

function emptyPlan(): PreviewRenderPlan {
  return {
    output_width: 1920,
    output_height: 1080,
    fps: 30,
    zoom_matrices: [],
    cursor_atlas_ref: null,
    ripples: [],
    highlights: [],
    text_boxes: [],
    background: null,
  };
}

function makeGlStub(): WebGL2RenderingContext {
  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE0: 0x84c0,
    TRIANGLES: 0x0004,
    createShader: vi.fn(() => ({}) as WebGLShader),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({}) as WebGLProgram),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => ({}) as WebGLVertexArrayObject),
    deleteVertexArray: vi.fn(),
    createTexture: vi.fn(() => ({}) as WebGLTexture),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    getUniformLocation: vi.fn(() => ({}) as WebGLUniformLocation),
    useProgram: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniformMatrix3fv: vi.fn(),
    bindVertexArray: vi.fn(),
    drawArrays: vi.fn(),
  };
  return gl as unknown as WebGL2RenderingContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PreviewEngine", () => {
  it("backend getter defaults to webgl2 before init", () => {
    const engine = new PreviewEngine({
      canvas: makeCanvas(() => null),
      videoElement: makeVideo(),
      outputWidth: 1920,
      outputHeight: 1080,
    });
    expect(engine.backend).toBe("webgl2");
  });

  it("renderFrame throws before init()", async () => {
    const engine = new PreviewEngine({
      canvas: makeCanvas(() => null),
      videoElement: makeVideo(),
      outputWidth: 1920,
      outputHeight: 1080,
    });
    await expect(engine.renderFrame(0, emptyPlan())).rejects.toThrow(/not initialised/i);
  });

  it("initialises into WebGL2 backend when navigator.gpu missing", async () => {
    stubNavigator(undefined);
    const gl = makeGlStub();
    const engine = new PreviewEngine({
      canvas: makeCanvas((id) => (id === "webgl2" ? gl : null)),
      videoElement: makeVideo(),
      outputWidth: 1920,
      outputHeight: 1080,
    });
    await engine.init();
    expect(engine.backend).toBe("webgl2");
    // Video not ready, so renderFrame is a no-op; should not throw.
    await engine.renderFrame(0, emptyPlan());
    engine.dispose();
    expect(engine.backend).toBe("webgl2"); // default after dispose
  });

  it("survives dispose + re-init (context re-acquired)", async () => {
    stubNavigator(undefined);
    const gl = makeGlStub();
    const engine = new PreviewEngine({
      canvas: makeCanvas((id) => (id === "webgl2" ? gl : null)),
      videoElement: makeVideo(),
      outputWidth: 1280,
      outputHeight: 720,
    });
    await engine.init();
    engine.dispose();
    await engine.init();
    expect(engine.backend).toBe("webgl2");
    engine.dispose();
  });

  it("routes WebGPU when navigator.gpu is present and adapter available", async () => {
    const device = {
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createSampler: vi.fn(() => ({})),
      createTexture: vi.fn(() => ({ destroy: vi.fn() })),
      queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const adapter = {
      features: new Set(),
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;
    const ctx = { configure: vi.fn() } as unknown as GPUCanvasContext;

    stubNavigator({
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: () => "bgra8unorm",
    });

    const engine = new PreviewEngine({
      canvas: makeCanvas((id) => (id === "webgpu" ? ctx : null)),
      videoElement: makeVideo(),
      outputWidth: 1920,
      outputHeight: 1080,
    });
    await engine.init();
    expect(engine.backend).toBe("webgpu");
    engine.dispose();
  });

  it("draws a paused ready frame through WebGPU", async () => {
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    };
    const encoder = {
      beginRenderPass: vi.fn(() => pass),
      finish: vi.fn(() => ({})),
    };
    const queue = {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
    };
    const device = {
      createShaderModule: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createSampler: vi.fn(() => ({})),
      createTexture: vi.fn(() => ({
        createView: vi.fn(() => ({})),
        destroy: vi.fn(),
      })),
      createBindGroup: vi.fn(() => ({})),
      importExternalTexture: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => encoder),
      queue,
    } as unknown as GPUDevice;
    const adapter = {
      features: new Set(),
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;
    const ctx = {
      configure: vi.fn(),
      getCurrentTexture: vi.fn(() => ({
        createView: vi.fn(() => ({})),
      })),
    } as unknown as GPUCanvasContext;
    const video = {
      readyState: 2,
      paused: true,
      videoWidth: 1920,
      videoHeight: 1080,
    } as unknown as HTMLVideoElement;

    stubNavigator({
      requestAdapter: vi.fn(async () => adapter),
      getPreferredCanvasFormat: () => "bgra8unorm",
    });

    const engine = new PreviewEngine({
      canvas: makeCanvas((id) => (id === "webgpu" ? ctx : null)),
      videoElement: video,
      outputWidth: 1920,
      outputHeight: 1080,
    });
    await engine.init();
    await engine.renderFrame(0, emptyPlan());

    expect(device.importExternalTexture).toHaveBeenCalledWith({ source: video });
    expect(pass.draw).toHaveBeenCalledWith(6, 1, 0, 0);
    expect(queue.submit).toHaveBeenCalledTimes(1);
    engine.dispose();
  });
});

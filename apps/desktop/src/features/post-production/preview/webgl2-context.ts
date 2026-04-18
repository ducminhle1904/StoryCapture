/**
 * Stub WebGL2 fallback for the preview engine.
 *
 * Uploads the current video frame each tick and draws it through the compositor shader.
 */
import type { PreviewRenderPlan } from "./types";
import { loadGlsl } from "../shaders/loader";

const MAX_RIPPLES = 32;

export interface WebGL2BackendConfig {
  canvas: HTMLCanvasElement;
  videoElement: HTMLVideoElement;
  outputWidth: number;
  outputHeight: number;
}

export class WebGL2Backend {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private videoTexture: WebGLTexture | null = null;
  private cursorTexture: WebGLTexture | null = null;
  private uniformLocations: Record<string, WebGLUniformLocation | null> = {};
  private disposed = false;
  // First upload allocates storage; later same-size uploads reuse it.
  private videoTextureAllocated = false;
  private videoTextureWidth = 0;
  private videoTextureHeight = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly config: WebGL2BackendConfig,
  ) {}

  async init(): Promise<void> {
    const { vert, frag } = loadGlsl();
    const program = this.linkProgram(vert, frag);
    this.program = program;

    this.vao = this.gl.createVertexArray();

    this.videoTexture = this.gl.createTexture();
    this.bindTextureDefaults(this.videoTexture);

    this.cursorTexture = this.gl.createTexture();
    this.bindTextureDefaults(this.cursorTexture);
    // 1x1 transparent fallback so the sampler is always valid.
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.cursorTexture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      1,
      1,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );

    this.cacheUniforms();
  }

  private bindTextureDefaults(tex: WebGLTexture | null): void {
    if (!tex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private linkProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("createShader failed");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(sh) ?? "(no log)";
        gl.deleteShader(sh);
        throw new Error(`Shader compile failed: ${info}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram failed");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog) ?? "(no log)";
      gl.deleteProgram(prog);
      throw new Error(`Program link failed: ${info}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  private cacheUniforms(): void {
    if (!this.program) return;
    const names = [
      "u_zoom",
      "u_output_size",
      "u_time_ms",
      "u_has_cursor",
      "u_ripple_count",
      "u_bg_kind",
      "u_bg_color_top",
      "u_bg_color_bottom",
      "u_video_frame",
      "u_cursor_atlas",
    ];
    for (const n of names) {
      this.uniformLocations[n] = this.gl.getUniformLocation(this.program, n);
    }
  }

  renderFrame(t_ms: number, plan: PreviewRenderPlan): void {
    if (this.disposed || !this.program) return;
    const gl = this.gl;
    const videoReady =
      this.config.videoElement.readyState >= 2 &&
      !this.config.videoElement.paused;
    if (!videoReady) return;

    gl.useProgram(this.program);
    // Reallocate only when the video size changes.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    const video = this.config.videoElement;
    const vw = video.videoWidth | 0;
    const vh = video.videoHeight | 0;
    const sizeChanged =
      vw !== this.videoTextureWidth || vh !== this.videoTextureHeight;
    if (!this.videoTextureAllocated || sizeChanged) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video,
      );
      this.videoTextureAllocated = true;
      this.videoTextureWidth = vw;
      this.videoTextureHeight = vh;
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video,
      );
    }
    const uVideo = this.uniformLocations.u_video_frame;
    if (uVideo) gl.uniform1i(uVideo, 0);

    const uZoom = this.uniformLocations.u_zoom;
    if (uZoom) {
      // Identity 3x3, column-major.
      gl.uniformMatrix3fv(uZoom, false, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    const uOut = this.uniformLocations.u_output_size;
    if (uOut) gl.uniform2f(uOut, plan.output_width, plan.output_height);
    const uTime = this.uniformLocations.u_time_ms;
    if (uTime) gl.uniform1f(uTime, t_ms);
    const uHasCursor = this.uniformLocations.u_has_cursor;
    if (uHasCursor) gl.uniform1i(uHasCursor, plan.cursor_atlas_ref ? 1 : 0);
    const uRippleCount = this.uniformLocations.u_ripple_count;
    if (uRippleCount)
      gl.uniform1i(uRippleCount, Math.min(plan.ripples.length, MAX_RIPPLES));

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Update the viewport after a canvas resize. */
  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.gl.viewport(0, 0, Math.max(1, width | 0), Math.max(1, height | 0));
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.videoTexture) gl.deleteTexture(this.videoTexture);
    if (this.cursorTexture) gl.deleteTexture(this.cursorTexture);
    this.program = null;
    this.vao = null;
    this.videoTexture = null;
    this.cursorTexture = null;
    this.uniformLocations = {};
  }
}

// WebGPU compositor shader (stub).
//
// Pipeline contract for Plans 05–10:
//   * Vertex stage emits a full-screen triangle pair (two triangles, no VB needed).
//   * Fragment stage samples an imported <video> frame as texture_external,
//     applies the 2D zoom transform from u_frame.zoom, alpha-blends the
//     background solid/gradient, draws up to 32 ripple SDF circles, then
//     overlays the cursor atlas sample.
//
// Bind group 0 layout (must match webgpu-context.ts exactly):
//   @binding(0) u_frame       : uniform  FrameUniforms
//   @binding(1) u_background  : uniform  BackgroundUniforms
//   @binding(2) u_ripples     : storage  array<RippleGpu, 32>, read
//   @binding(3) u_video       : texture_external
//   @binding(4) u_cursor_atlas: texture_2d<f32>
//   @binding(5) u_sampler     : sampler
//
// Downstream plans (05 zoom / 06 cursor / 09 ripples / 07 text) specialise the
// uniform values; this stub just wires the slots so the pipeline compiles.

struct FrameUniforms {
  zoom       : mat3x3<f32>,
  output_size: vec2<f32>,
  time_ms    : f32,
  has_cursor : u32,
  ripple_n   : u32,
  _pad0      : u32,
  _pad1      : u32,
  _pad2      : u32,
};

struct BackgroundUniforms {
  color_top    : vec4<f32>,
  color_bottom : vec4<f32>,
  kind         : u32, // 0=solid, 1=gradient, 2=image (image path handled host-side for stub)
  _pad         : u32,
};

struct RippleGpu {
  center         : vec2<f32>,
  t_anticipate_ms: f32,
  t_impact_ms    : f32,
  duration_ms    : f32,
  max_radius_px  : f32,
  color          : vec4<f32>,
};

@group(0) @binding(0) var<uniform>            u_frame        : FrameUniforms;
@group(0) @binding(1) var<uniform>            u_background   : BackgroundUniforms;
@group(0) @binding(2) var<storage, read>      u_ripples      : array<RippleGpu, 32>;
@group(0) @binding(3) var                      u_video       : texture_external;
@group(0) @binding(4) var                      u_cursor_atlas: texture_2d<f32>;
@group(0) @binding(5) var                      u_sampler     : sampler;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0)       uv  : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VsOut {
  // Full-screen triangle pair via vertex index.
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0),
  );
  var out : VsOut;
  out.pos = vec4<f32>(positions[vi], 0.0, 1.0);
  out.uv  = uvs[vi];
  return out;
}

fn apply_zoom(uv : vec2<f32>) -> vec2<f32> {
  let p = u_frame.zoom * vec3<f32>(uv, 1.0);
  return p.xy;
}

fn background_color(uv : vec2<f32>) -> vec4<f32> {
  if (u_background.kind == 1u) {
    return mix(u_background.color_top, u_background.color_bottom, uv.y);
  }
  return u_background.color_top;
}

fn ripple_contribution(px : vec2<f32>) -> vec4<f32> {
  var acc = vec4<f32>(0.0);
  let n = min(u_frame.ripple_n, 32u);
  for (var i : u32 = 0u; i < n; i = i + 1u) {
    let r = u_ripples[i];
    let dt = u_frame.time_ms - r.t_impact_ms;
    if (dt < 0.0 || dt > r.duration_ms) { continue; }
    let progress = dt / r.duration_ms;
    let radius = r.max_radius_px * progress;
    let d = distance(px, r.center);
    // Thin SDF ring
    let thickness = 4.0;
    let ring = 1.0 - smoothstep(thickness, thickness + 2.0, abs(d - radius));
    acc = acc + r.color * ring * (1.0 - progress);
  }
  return acc;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let zoomed_uv = apply_zoom(in.uv);
  let video_sample = textureSampleBaseClampToEdge(u_video, u_sampler, zoomed_uv);
  let bg = background_color(in.uv);
  var color = mix(bg, video_sample, video_sample.a);

  let px = in.uv * u_frame.output_size;
  color = color + ripple_contribution(px);

  if (u_frame.has_cursor == 1u) {
    let cursor = textureSample(u_cursor_atlas, u_sampler, in.uv);
    color = mix(color, cursor, cursor.a);
  }

  return vec4<f32>(color.rgb, 1.0);
}

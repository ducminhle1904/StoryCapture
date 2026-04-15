#version 300 es
// WebGL2 compositor fragment shader (stub, mirrors compositor.wgsl fs_main).
//
// WebGL2 has no storage buffers and no texture_external; we emulate:
//   * Video frame is uploaded per-tick via texImage2D from the <video> element
//     into u_video_frame.
//   * Ripples use fixed-size uniform arrays (capped at MAX_RIPPLES = 32).
//   * Zoom is a mat3.
//
// Slower than the WebGPU path (full texture upload per frame instead of zero-
// copy GPUExternalTexture), but universal across 2026 hardware.

precision highp float;

const int MAX_RIPPLES = 32;

in vec2 v_uv;
out vec4 out_color;

uniform mat3  u_zoom;
uniform vec2  u_output_size;
uniform float u_time_ms;
uniform int   u_has_cursor;
uniform int   u_ripple_count;

uniform int   u_bg_kind;           // 0=solid, 1=gradient, 2=image
uniform vec4  u_bg_color_top;
uniform vec4  u_bg_color_bottom;

uniform vec2  u_ripple_center[MAX_RIPPLES];
uniform float u_ripple_t_impact[MAX_RIPPLES];
uniform float u_ripple_duration[MAX_RIPPLES];
uniform float u_ripple_max_radius[MAX_RIPPLES];
uniform vec4  u_ripple_color[MAX_RIPPLES];

uniform sampler2D u_video_frame;
uniform sampler2D u_cursor_atlas;

vec2 apply_zoom(vec2 uv) {
  vec3 p = u_zoom * vec3(uv, 1.0);
  return p.xy;
}

vec4 background_color(vec2 uv) {
  if (u_bg_kind == 1) {
    return mix(u_bg_color_top, u_bg_color_bottom, uv.y);
  }
  return u_bg_color_top;
}

vec4 ripple_contribution(vec2 px) {
  vec4 acc = vec4(0.0);
  int n = min(u_ripple_count, MAX_RIPPLES);
  for (int i = 0; i < MAX_RIPPLES; i++) {
    if (i >= n) break;
    float dt = u_time_ms - u_ripple_t_impact[i];
    if (dt < 0.0 || dt > u_ripple_duration[i]) continue;
    float progress = dt / u_ripple_duration[i];
    float radius = u_ripple_max_radius[i] * progress;
    float d = distance(px, u_ripple_center[i]);
    float thickness = 4.0;
    float ring = 1.0 - smoothstep(thickness, thickness + 2.0, abs(d - radius));
    acc += u_ripple_color[i] * ring * (1.0 - progress);
  }
  return acc;
}

void main() {
  vec2 zoomed_uv = apply_zoom(v_uv);
  vec4 video_sample = texture(u_video_frame, zoomed_uv);
  vec4 bg = background_color(v_uv);
  vec4 color = mix(bg, video_sample, video_sample.a);

  vec2 px = v_uv * u_output_size;
  color += ripple_contribution(px);

  if (u_has_cursor == 1) {
    vec4 cursor = texture(u_cursor_atlas, v_uv);
    color = mix(color, cursor, cursor.a);
  }

  out_color = vec4(color.rgb, 1.0);
}

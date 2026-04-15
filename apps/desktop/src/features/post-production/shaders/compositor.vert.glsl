#version 300 es
// WebGL2 compositor vertex shader (stub, mirrors compositor.wgsl vs_main).
// Emits a full-screen triangle pair from gl_VertexID; no vertex buffer needed.

precision highp float;

out vec2 v_uv;

void main() {
  const vec2 positions[6] = vec2[6](
    vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
    vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0)
  );
  const vec2 uvs[6] = vec2[6](
    vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0)
  );
  v_uv = uvs[gl_VertexID];
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}

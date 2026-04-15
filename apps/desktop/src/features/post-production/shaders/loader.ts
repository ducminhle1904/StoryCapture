/**
 * Shader source loader.
 *
 * Vite's `?raw` suffix inlines the shader text at build time so the
 * final bundle does not have to fetch shader files at runtime. Keeping
 * the shader source as files (not string literals) preserves editor
 * syntax highlighting and makes shader linting tools work.
 */
import compositorWgsl from "./compositor.wgsl?raw";
import compositorVert from "./compositor.vert.glsl?raw";
import compositorFrag from "./compositor.frag.glsl?raw";

export function loadWgsl(): string {
  return compositorWgsl;
}

export function loadGlsl(): { vert: string; frag: string } {
  return { vert: compositorVert, frag: compositorFrag };
}

---
phase: 02-cinematic-post-production-export
plan: 04
subsystem: desktop-preview
tags: [webgpu, webgl2, preview, compositor, videoframe, feature-detection, wgsl, shaders, vitest, happy-dom]
requires:
  - "01-03b (React 19 + Vite 6 + Tailwind v4 desktop scaffold)"
  - "02-01 (crates/effects::PreviewRenderPlan — shape mirrored locally pending ts-rs export through @storycapture/shared-types)"
provides:
  - "apps/desktop/src/features/post-production/preview/gpu.ts::initPreviewContext"
  - "apps/desktop/src/features/post-production/preview/video-frame-lifecycle.ts::withVideoFrame"
  - "apps/desktop/src/features/post-production/preview/preview-engine.ts::PreviewEngine (backend-agnostic facade)"
  - "apps/desktop/src/features/post-production/preview/types.ts::PreviewRenderPlan (local mirror)"
  - "apps/desktop/src/features/post-production/shaders/compositor.wgsl (WebGPU compositor stub)"
  - "apps/desktop/src/features/post-production/shaders/compositor.{vert,frag}.glsl (WebGL2 equivalents)"
  - "apps/desktop/src/features/post-production/shaders/loader.ts (Vite ?raw inliner)"
  - "apps/desktop/vitest.config.ts (happy-dom environment)"
affects:
  - "Plan 02-05 (zoom interpolation) writes FrameUniforms.zoom via this pipeline"
  - "Plan 02-06 (cursor overlay) populates cursorAtlas texture + sets has_cursor flag"
  - "Plan 02-07 (text overlays) renders via FFmpeg drawtext on export; preview overlays will be added later"
  - "Plan 02-09 (ripples) fills the 32-slot ripple storage buffer / uniform array"
  - "Plan 02-11 (backgrounds) writes BackgroundUniforms"
  - "Plan 02-12 (post-production editor UI) instantiates PreviewEngine in useEffect and calls renderFrame on the scrub/play tick"
tech-stack:
  added:
    - "vitest@^4 (dev)"
    - "@vitest/ui (dev)"
    - "happy-dom (dev)"
    - "@webgpu/types (dev)"
  patterns:
    - "GPU enum flags (GPUShaderStage / GPUBufferUsage / GPUTextureUsage) inlined as literal bitflags so the source loads under happy-dom which does not inject the WebGPU globals"
    - "?raw shader import with a co-located vite-env.d.ts referencing vite/client + @webgpu/types — shaders live as real files for editor highlighting, not string literals"
    - "Backend-agnostic facade: PreviewEngine chooses WebGPUBackend or WebGL2Backend at init() then delegates renderFrame/dispose through a minimal structural Backend interface"
    - "VideoFrame acquire/use/close enforced by withVideoFrame<T>(acquire, use) — try/finally wrap is the only supported way to touch a VideoFrame in the preview module"
key-files:
  created:
    - "apps/desktop/vitest.config.ts"
    - "apps/desktop/src/vite-env.d.ts"
    - "apps/desktop/src/features/post-production/preview/types.ts"
    - "apps/desktop/src/features/post-production/preview/gpu.ts"
    - "apps/desktop/src/features/post-production/preview/video-frame-lifecycle.ts"
    - "apps/desktop/src/features/post-production/preview/preview-engine.ts"
    - "apps/desktop/src/features/post-production/preview/webgpu-context.ts"
    - "apps/desktop/src/features/post-production/preview/webgl2-context.ts"
    - "apps/desktop/src/features/post-production/shaders/compositor.wgsl"
    - "apps/desktop/src/features/post-production/shaders/compositor.vert.glsl"
    - "apps/desktop/src/features/post-production/shaders/compositor.frag.glsl"
    - "apps/desktop/src/features/post-production/shaders/loader.ts"
    - "apps/desktop/src/features/post-production/preview/__tests__/gpu.test.ts"
    - "apps/desktop/src/features/post-production/preview/__tests__/video-frame-lifecycle.test.ts"
    - "apps/desktop/src/features/post-production/preview/__tests__/preview-engine.integration.test.ts"
  modified:
    - "apps/desktop/package.json (added vitest + happy-dom + @webgpu/types + @vitest/ui devDeps)"
    - "pnpm-lock.yaml"
decisions:
  - "Inlined GPUShaderStage/GPUBufferUsage/GPUTextureUsage values (0x2 / 0x40 / 0x80 / 0x8 / 0x4 / 0x1) in webgpu-context.ts because happy-dom does not provide those globals and the source must evaluate under the test runner. Each constant has a comment naming the original enum member."
  - "Kept a LOCAL PreviewRenderPlan mirror in preview/types.ts rather than importing from @storycapture/shared-types. The shared-types generated file evolves with Plan 02-01 and Plan 02-02 changes; swapping is a one-line replace later (documented at the top of types.ts)."
  - "Structural Backend interface rather than abstract class so a future test double can implement it without subclassing the full WebGPU/WebGL2 scaffolding."
  - "Shader files kept as real .wgsl/.glsl modules imported with ?raw rather than inline string literals — preserves syntax highlighting, enables shader linting later, and Vite handles the inlining zero-cost."
metrics:
  duration: "~25 minutes"
  completed: "2026-04-15T20:20:00Z"
  task_count: 2
  test_count: 15
  file_count: 15
---

# Phase 2 Plan 04: WebGPU-Primary / WebGL2-Fallback Preview Compositor Summary

## One-liner

Bootstrapped the Post-Production preview compositor: `PreviewEngine` owns a WebGPU-primary / WebGL2-fallback GPU context with a `VideoFrame` lifecycle guard, stub WGSL + GLSL compositor shaders, and 15 Vitest tests covering feature detection, close() enforcement, and engine lifecycle — the foundation every downstream Phase 2 shader plan plugs into.

## What Was Built

### Public API surface

```typescript
// preview/gpu.ts
export type PreviewBackend = "webgpu" | "webgl2";
export type PreviewCtx =
  | { kind: "webgpu"; device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat; adapter: GPUAdapter }
  | { kind: "webgl2"; gl: WebGL2RenderingContext };
export async function initPreviewContext(canvas: HTMLCanvasElement): Promise<PreviewCtx>;

// preview/video-frame-lifecycle.ts
export type FrameAcquireFn = () => Promise<VideoFrame>;
export async function withVideoFrame<T>(
  acquire: FrameAcquireFn,
  use: (f: VideoFrame) => Promise<T>,
): Promise<T>;

// preview/preview-engine.ts
export interface PreviewEngineConfig {
  canvas: HTMLCanvasElement;
  videoElement: HTMLVideoElement;
  outputWidth: number;
  outputHeight: number;
}
export class PreviewEngine {
  constructor(config: PreviewEngineConfig);
  init(): Promise<void>;
  renderFrame(t_ms: number, plan: PreviewRenderPlan): Promise<void>;
  dispose(): void;
  get backend(): PreviewBackend;
}
```

### Shader bind group layout

**WebGPU (`compositor.wgsl`), bind group 0:**

| Binding | Stage    | Resource                                     | Populated by         |
| ------- | -------- | -------------------------------------------- | -------------------- |
| 0       | fragment | `uniform FrameUniforms` (zoom, size, time, flags, ripple_n) | P02-05 / P02-09      |
| 1       | fragment | `uniform BackgroundUniforms`                 | P02-11               |
| 2       | fragment | `storage read array<RippleGpu, 32>`          | P02-09               |
| 3       | fragment | `texture_external` video                     | this plan (stub) + P02-12 |
| 4       | fragment | `texture_2d<f32>` cursor atlas               | P02-06               |
| 5       | fragment | `sampler`                                    | this plan            |

**WebGL2 (`compositor.frag.glsl`), uniform set:**

| Uniform                               | Type             | Populated by |
| ------------------------------------- | ---------------- | ------------ |
| `u_zoom`                              | `mat3`           | P02-05       |
| `u_output_size`, `u_time_ms`          | `vec2`, `float`  | this plan    |
| `u_has_cursor`, `u_ripple_count`      | `int`            | P02-06 / P02-09 |
| `u_bg_kind`, `u_bg_color_top`, `u_bg_color_bottom` | ... | P02-11       |
| `u_ripple_center[32]`, `u_ripple_t_impact[32]`, `u_ripple_duration[32]`, `u_ripple_max_radius[32]`, `u_ripple_color[32]` | arrays | P02-09 |
| `u_video_frame`                       | `sampler2D`      | this plan (texImage2D from `<video>`) |
| `u_cursor_atlas`                      | `sampler2D`      | P02-06       |

### PreviewRenderPlan field consumption

| Field              | Consumed where                              | Plan that wires it |
| ------------------ | ------------------------------------------- | ------------------ |
| `output_width/height` | FrameUniforms.output_size                | this plan          |
| `fps`              | host-side scheduling (not read in engine)   | P02-12 player loop |
| `zoom_matrices`    | FrameUniforms.zoom                          | P02-05             |
| `cursor_atlas_ref` | `has_cursor` flag + atlas texture binding   | P02-06             |
| `ripples`          | ripple storage buffer (WebGPU) / uniform arrays (WebGL2), capped at 32 | P02-09 |
| `text_boxes`       | NOT consumed here — final-render only via FFmpeg drawtext | P02-07 |
| `background`       | BackgroundUniforms                          | P02-11             |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] WebGPU enum globals unavailable under happy-dom**
- **Found during:** Task 2 integration test run — `ReferenceError: GPUShaderStage is not defined` when calling `device.createBindGroupLayout` inside `WebGPUBackend.init()`.
- **Issue:** happy-dom does not inject `GPUShaderStage` / `GPUBufferUsage` / `GPUTextureUsage` runtime globals; `@webgpu/types` only provides the TS shape. The source literally evaluated `GPUShaderStage.FRAGMENT` at runtime and exploded.
- **Fix:** Inlined the bitflag values as local consts (`FRAGMENT = 0x2`, `BUF_UNIFORM = 0x40`, etc.) with a comment naming the original enum member. These values are part of the WebGPU 1.0 spec and will not change.
- **Files modified:** `apps/desktop/src/features/post-production/preview/webgpu-context.ts`.
- **Commit:** `4668180`.

**2. [Rule 3 — Blocking] TS6133 strict-unused on fields held for later plans**
- **Found during:** `pnpm typecheck` after Task 2.
- **Issue:** `WebGPUBackend.sampler` and `WebGPUBackend.context` are created for future plans (06/09 bind them at draw time; resize-triggered re-configure reads context) but not yet read, tripping `noUnusedLocals`/`noUnusedParameters`.
- **Fix:** Added `void this.sampler` / `void this.context` statements in `dispose()` plus an explanatory comment; preserves the fields for downstream plans without adding any runtime effect.
- **Commit:** `4668180`.

**3. [Rule 3 — Blocking] No vitest setup existed in apps/desktop**
- **Found during:** Task 1 init.
- **Issue:** Plan 01-03b scaffolded React + Vite but never wired a test runner; plan required Vitest + happy-dom.
- **Fix:** Installed `vitest`, `@vitest/ui`, `happy-dom`, `@webgpu/types` as devDeps; created `apps/desktop/vitest.config.ts` mirroring `vite.config.ts` alias resolution with `test.environment: "happy-dom"`.
- **Commit:** `1198b9d`.

**4. [Rule 3 — Blocking] Missing `vite-env.d.ts` for `?raw` module declarations**
- **Found during:** Task 2 typecheck of `shaders/loader.ts` (`import … from './compositor.wgsl?raw'`).
- **Fix:** Added `apps/desktop/src/vite-env.d.ts` with `/// <reference types="vite/client" />` + `/// <reference types="@webgpu/types" />`. Covers both the `?raw` module declarations and ambient WebGPU types for source files that do not carry their own triple-slash reference.
- **Commit:** `4668180`.

### Auth Gates

None.

### Out-of-Scope Discoveries (deferred)

- `packages/shared-types/src/generated/effects.ts` has an uncommitted diff from Plan 02-03 work (unrelated to this plan). Left untouched; belongs to that plan's commit.

## Known Stubs

These are intentional placeholders — the plan is **plumbing-only**. Downstream plans replace them:

- `WebGPUBackend.renderFrame` / `WebGL2Backend.renderFrame` — issue no draw call yet. Video readiness is gated but the uniform-buffer upload and `drawArrays`/`drawIndexed` are stubs. Plan 02-12 will drive actual rendering from the post-production editor's scrub ticker.
- WGSL fragment shader ignores `u_cursor_atlas` except in the `has_cursor == 1u` branch; when no atlas is bound (Plan 02-06 not yet shipped) the branch is never taken.
- Ripple animation is a placeholder SDF ring; Plan 02-09 will replace with the anticipation/impact/decay curve defined in Research §6.
- `buildFrameUniforms` writes an identity zoom matrix; Plan 02-05 will interpolate from `plan.zoom_matrices`.
- Cursor atlas is a 1×1 placeholder texture (both backends) — Plan 02-06 uploads the PNG sequence atlas.
- `text_boxes` intentionally not routed through the preview shader: text overlays render via FFmpeg drawtext on final export (Plan 02-07). Preview text will be composited as a DOM overlay on top of the canvas in Plan 02-12.

## Threat Surface Scan

No new trust boundaries introduced beyond the plan's `<threat_model>`. The three declared mitigations are in place:

- **T-02-11 (VideoFrame leak DoS):** `withVideoFrame` try/finally enforces `close()`; tests cover success, error-in-use, and idempotent-close paths.
- **T-02-12 (infinite-ripples DoS):** Both backends cap at `MAX_RIPPLES = 32` (`Math.min(plan.ripples.length, 32)`); WGSL binding layout is `array<RippleGpu, 32>` so the GPU cannot read past the cap.
- **T-02-13 (context loss on webview navigate):** `PreviewEngine.dispose()` + `init()` are idempotent; integration test `survives dispose + re-init` exercises the path.

## Test Coverage Summary

| Suite                                     | Tests | Notes                                               |
| ----------------------------------------- | ----- | --------------------------------------------------- |
| `gpu.test.ts`                             | 5     | webgpu happy path, navigator.gpu undefined, adapter null, no backends throws, webgpu-context-null falls back |
| `video-frame-lifecycle.test.ts`           | 5     | close on success, close on error, no double close, swallow close error, acquire-reject propagates |
| `preview-engine.integration.test.ts`      | 5     | backend default pre-init, renderFrame throws pre-init, webgl2 init, dispose+reinit, webgpu route |
| **Total**                                 | **15**| all passing, ~250 ms wall time                      |

## Verification Results

| Gate                                                                                             | Result |
| ------------------------------------------------------------------------------------------------ | ------ |
| `pnpm --filter @storycapture/desktop exec vitest run src/features/post-production/preview/`      | PASS — 15/15 |
| `pnpm --filter @storycapture/desktop typecheck` (`tsc -b --noEmit`)                              | PASS — exit 0 |
| `pnpm --filter @storycapture/desktop exec vite build` (`?raw` imports resolve, bundle emits)     | PASS — ~1 MB JS + CSS produced |
| `grep -q "'gpu' in navigator" apps/desktop/src/features/post-production/preview/gpu.ts`          | PASS |
| `grep -q "frame.close()" apps/desktop/src/features/post-production/preview/video-frame-lifecycle.ts` | PASS |
| `grep -q "Neither WebGPU nor WebGL2 available" apps/desktop/src/features/post-production/preview/gpu.ts` | PASS |
| `grep -q "texture_external" apps/desktop/src/features/post-production/shaders/compositor.wgsl`    | PASS |
| `grep -q "u_video" apps/desktop/src/features/post-production/shaders/compositor.wgsl` (binding 3) | PASS |
| `grep -q "#version 300 es" apps/desktop/src/features/post-production/shaders/compositor.frag.glsl` | PASS |
| `grep -q "export class PreviewEngine" apps/desktop/src/features/post-production/preview/preview-engine.ts` | PASS |
| `grep -q "initPreviewContext(this.config.canvas)" apps/desktop/src/features/post-production/preview/preview-engine.ts` | PASS |

## Known Limitations

- Ripple count capped at 32 per frame (matches the bind-group layout and uniform-array size).
- WebGL2 path uploads the `<video>` element via `texImage2D` every tick — slower than the WebGPU zero-copy `importExternalTexture`, but universal.
- `renderFrame` is a stub: gates on `videoElement.readyState >= 2 && !paused` then writes only the frame UBO (WebGPU) or sets uniforms + binds VAO + drawArrays (WebGL2). No actual scene is drawn until downstream plans populate uniforms.
- `@webgpu/types` is referenced via `/// <reference types="@webgpu/types" />` triple-slash in the files that need GPU globals, and globally in `vite-env.d.ts`. Running outside the test harness, the browser supplies the runtime.
- `packages/shared-types` does not yet re-export `PreviewRenderPlan`; local mirror lives at `apps/desktop/src/features/post-production/preview/types.ts` with a drift-warning comment.

## Self-Check: PASSED

Verification run:
- `[ -f apps/desktop/vitest.config.ts ]` → FOUND
- `[ -f apps/desktop/src/vite-env.d.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/types.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/gpu.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/video-frame-lifecycle.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/preview-engine.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/webgpu-context.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/webgl2-context.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/shaders/compositor.wgsl ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/shaders/compositor.vert.glsl ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/shaders/compositor.frag.glsl ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/shaders/loader.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/__tests__/gpu.test.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/__tests__/video-frame-lifecycle.test.ts ]` → FOUND
- `[ -f apps/desktop/src/features/post-production/preview/__tests__/preview-engine.integration.test.ts ]` → FOUND
- Commit `1198b9d` (Task 1 — feature detection + VideoFrame lifecycle + tests): FOUND
- Commit `4668180` (Task 2 — PreviewEngine + backends + stub shaders + integration test): FOUND

# 2026-05-02 Post-Production Preview Zoom Plan

## Status

Implemented locally on 2026-05-02.

Verification completed:

```bash
rtk pnpm exec biome check --write apps/desktop/src/features/post-production/preview/preview-player.tsx apps/desktop/src/features/post-production/preview/__tests__/preview-player.test.tsx
rtk pnpm --filter @storycapture/desktop exec vitest run src/features/post-production/preview/__tests__/preview-player.test.tsx --reporter=dot
rtk pnpm --filter @storycapture/desktop exec vitest run src/features/post-production/preview src/features/post-production/inspector src/features/post-production/__tests__/store.test.ts src/features/post-production/__tests__/build-timeline-from-story.test.ts src/features/post-production/__tests__/compute-graph.test.ts --reporter=dot
rtk pnpm --filter @storycapture/desktop exec tsc --noEmit
rtk cargo test -p effects cursor
rtk cargo test -p encoder export_run_preprocesses_cursor_actions_json_before_snapshot
rtk cargo fmt --check
rtk git diff --check
```

Implementation notes:

- Native preview now applies active timeline zoom clips through a CSS transform
  layer around the video/canvas and virtual cursor overlay.
- Scrubbing while paused and playback both update the zoom transform.
- Cursor overlay is inside the same transformed coordinate space as the video.
- Export path was inspected and already projects zoom clips into `zoom-pan`
  graph nodes, then FFmpeg emits `zoompan=...`; this fix targets the missing
  preview consumption path.

## Goal

Make the Post Production preview visually reflect zoom clips on the timeline.

The current user-visible issue is: zoom clips appear on the `Zoom` track, but the preview image does not zoom when the playhead enters those clips.

This plan intentionally targets the shortest safe fix first: apply timeline zooms in the existing native-video preview path using CSS transforms. Do not switch the preview to the GPU compositor yet.

## Current Findings

The timeline/export side already creates zoom data:

- `apps/desktop/src/features/post-production/state/compute-graph.ts`
  - `computeGraph()` pushes `zoomPan(clip)` for every `tracks.zoom` clip.
  - The resulting graph includes `VideoNode` entries with `type: "zoom-pan"`.
- `crates/effects/src/emit/preview.rs`
  - `emit_preview_plan()` expands Rust `VideoNode::ZoomPan` into `PreviewRenderPlan.zoom_matrices`.

The preview UI does not currently consume that data:

- `apps/desktop/src/features/post-production/preview/preview-player.tsx`
  - `DEFAULT_PREVIEW_OUTPUT_MODE` is `"native-video"`.
  - `buildPlan()` returns `zoom_matrices: []`.
  - Native path renders a plain `<video aria-label="Source video preview">`.
- `apps/desktop/src/components/preview-surface/preview-surface.tsx`
  - Does not pass `outputMode`, so `PreviewPlayer` uses native video by default.
- `apps/desktop/src/features/post-production/preview/webgpu-context.ts`
  - `buildFrameUniforms()` hard-codes an identity zoom matrix.
- `apps/desktop/src/features/post-production/preview/webgl2-context.ts`
  - `renderFrame()` hard-codes an identity zoom matrix.

Conclusion: this is not a missing zoom clip problem. It is a preview pipeline gap.

## Assumptions

- User wants preview behavior fixed before full compositor parity.
- Export behavior should not change in this phase.
- Timeline model should remain unchanged.
- `ZoomClip.center` is normalized scene coordinates in the `0..1` range for current UI-generated clips.
- CSS preview zoom can be approximate, but it must be visually obvious and deterministic.
- Cursor overlay should visually stay attached to the zoomed video, because a cursor that remains unzoomed over a zoomed video feels wrong.

## Non-Goals

Do not do these in this phase:

- Do not change FFmpeg export.
- Do not change Rust `effects` AST or `PreviewEmit`.
- Do not change default preview mode to `composited-canvas`.
- Do not implement GPU matrix sampling from `zoom_matrices`.
- Do not refactor `PreviewPlayer` broadly.
- Do not alter timeline clip generation or polish sidecar parsing unless a test proves it is required.

## Success Criteria

1. When playhead is outside any zoom clip, preview renders with no zoom transform.
2. When playhead is inside a zoom clip, preview visibly scales toward `clip.scale`.
3. Scrubbing while paused updates the zoom immediately.
4. Playback updates the zoom continuously.
5. Cursor overlay remains in the same transformed coordinate space as the video.
6. Existing native preview tests still pass.
7. Add focused tests for active/inactive zoom transform behavior.

## Implementation Plan

### Step 1: Add a Small Zoom Sampling Helper

File:

- `apps/desktop/src/features/post-production/preview/preview-player.tsx`

Add helper logic near the other local preview helpers.

Suggested shape:

```ts
interface ActivePreviewZoom {
  scale: number;
  center: { x: number; y: number };
}

function activeZoomClip(clips: readonly ZoomClip[], playheadMs: number): ZoomClip | null {
  let active: ZoomClip | null = null;
  for (const clip of clips) {
    const endMs = clip.startMs + clip.durationMs;
    if (playheadMs < clip.startMs || playheadMs >= endMs) continue;
    if (!active || clip.startMs >= active.startMs) active = clip;
  }
  return active;
}

function samplePreviewZoom(clips: readonly ZoomClip[], playheadMs: number): ActivePreviewZoom {
  const clip = activeZoomClip(clips, playheadMs);
  if (!clip) return { scale: 1, center: { x: 0.5, y: 0.5 } };

  const duration = Math.max(1, clip.durationMs);
  const progress = Math.max(0, Math.min(1, (playheadMs - clip.startMs) / duration));
  const eased = easeInOutCubic(progress);
  const targetScale = Number.isFinite(clip.scale) ? Math.max(1, clip.scale) : 1;

  return {
    scale: 1 + (targetScale - 1) * eased,
    center: clip.center ?? { x: 0.5, y: 0.5 },
  };
}
```

Keep the helper local unless tests need it exported. If exporting makes tests cleaner, export only helper functions and keep names specific to preview zoom.

Use a simple local easing function:

```ts
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
```

### Step 2: Subscribe to Zoom Clips and Track Rendered Transform State

In `PreviewPlayer`:

- Import `ZoomClip` type from `timeline-slice`.
- Add:

```ts
const zoomClips = useEditorStore((s) => s.tracks.zoom);
const zoomClipsRef = useRef<ZoomClip[]>([]);
const previewFrameContentRef = useRef<HTMLDivElement | null>(null);
```

Sync `zoomClipsRef.current = zoomClips` in an effect, similar to `cursorClipsRef`.

The transform should be applied imperatively alongside playhead/cursor updates to avoid re-rendering on every animation frame.

### Step 3: Wrap Video, Canvas, and Cursor Overlay in One Transform Layer

Current relevant structure:

- Outer frame div controls size, border, clipping.
- Inside it, native `<video>` or `<canvas>` is rendered.
- Cursor overlay is absolutely positioned as sibling on top.

Add an inner wrapper inside the outer frame:

```tsx
<div
  ref={previewFrameContentRef}
  className="relative h-full w-full will-change-transform"
  style={{
    transformOrigin: "50% 50%",
    transform: "translate3d(0, 0, 0) scale(1)",
  }}
>
  {video or canvas}
  {cursor overlay}
</div>
```

Move both the video/canvas and cursor overlay inside this wrapper.

Keep the outer frame `overflow-hidden`, so the zoom crops naturally.

Important: do not transform the transport controls or stage background.

### Step 4: Apply Zoom Transform From Playhead

Add a function:

```ts
const applyPreviewZoom = useCallback((playheadMs: number) => {
  const el = previewFrameContentRef.current;
  if (!el) return;

  const sampled = samplePreviewZoom(zoomClipsRef.current, playheadMs);
  const scale = sampled.scale;
  const cx = Math.max(0, Math.min(1, sampled.center.x));
  const cy = Math.max(0, Math.min(1, sampled.center.y));

  el.style.transformOrigin = `${cx * 100}% ${cy * 100}%`;
  el.style.transform = `translate3d(0, 0, 0) scale(${scale})`;
}, []);
```

Why `transform-origin` instead of translating manually:

- It is simpler.
- It maps directly to "zoom around this normalized point".
- It avoids matrix math in this first phase.

Call `applyPreviewZoom(playheadMs)` in every place that already calls `renderCursorOverlay(playheadMs)`:

- Store subscription for paused scrubbing.
- Loaded frame render.
- Native playback rAF loop.
- Composited playback rAF loop, even though composited mode is not default.
- Effect that syncs cursor/action refs should also apply current zoom after updating refs.

Dependency note:

- Include `applyPreviewZoom` in effect dependency arrays where used.
- Keep helper stable with refs so it does not recreate on every `zoomClips` update.

### Step 5: Reset Transform When No Video Is Present

When there is no `resolvedSrc`, the placeholder still uses the hidden video ref. Make sure the transform remains identity.

This should naturally happen if no zoom clip is active, but add a small guard if needed:

```ts
if (!resolvedSrc) {
  el.style.transformOrigin = "50% 50%";
  el.style.transform = "translate3d(0, 0, 0) scale(1)";
  return;
}
```

Only add this if tests or manual inspection show placeholder zooming.

### Step 6: Add Tests

File:

- `apps/desktop/src/features/post-production/preview/__tests__/preview-player.test.tsx`

Add focused tests:

1. Native preview does not initialize `PreviewEngine` but applies zoom transform when playhead is inside a zoom clip.

Suggested setup:

```ts
useEditorStore.setState({
  tracks: {
    video: [],
    cursor: [],
    zoom: [
      {
        id: "zoom-1",
        trackId: "zoom",
        startMs: 1000,
        durationMs: 1000,
        label: "Zoom",
        target: { kind: "cursor" },
        scale: 2,
        center: { x: 0.25, y: 0.75 },
        preset: "DYNAMIC",
      },
    ],
    sound: [],
    annotations: [],
  },
});
```

Render `PreviewPlayer`, set playhead to `1500`, then assert:

- Some stable test node has `style.transform` containing `scale(` and not `scale(1)`.
- `style.transformOrigin` is `25% 75%`.
- `PreviewEngine` has not been called.

To make the test stable, add `data-testid="preview-frame-content"` to the transform wrapper.

2. Transform returns to identity outside zoom clip.

Set playhead inside first, assert zoomed, then set playhead after clip end, assert:

- `transform` includes `scale(1)`.
- `transformOrigin` is `50% 50%` or whichever identity origin implementation chooses.

3. Cursor overlay remains inside transformed content.

This can be simple:

- Render with active cursor clip and zoom clip.
- Assert `data-testid="virtual-cursor-overlay"` is contained by `data-testid="preview-frame-content"`.

Do not add brittle pixel tests here.

### Step 7: Run Verification

Run:

```bash
rtk pnpm --filter @storycapture/desktop test -- preview-player.test.tsx
rtk pnpm --filter @storycapture/desktop test -- compute-graph.test.ts
```

If there are type or lint issues, run the repo's normal desktop check command if available in `apps/desktop/package.json`. Inspect scripts first:

```bash
rtk pnpm --filter @storycapture/desktop run
```

Do not run broad Rust tests for this phase unless Rust files are changed.

## Edge Cases To Handle

- Overlapping zoom clips: choose the latest-starting active clip. This matches existing cursor active-clip behavior.
- Zero or negative duration: clamp duration to at least `1`.
- Invalid scale: fallback to `1`.
- Scale below `1`: clamp to `1` for preview. Timeline zoom clips are meant to zoom in; zoom-out behavior can be designed later.
- Center outside `0..1`: clamp for CSS transform origin.
- Playhead exactly at clip end: treat as inactive, consistent with cursor clip behavior.

## Why This Phase Is Native CSS Instead Of GPU

The GPU path currently has two blockers:

- `PreviewPlayer.buildPlan()` emits an empty plan with `zoom_matrices: []`.
- Both WebGPU and WebGL2 backends upload identity zoom matrices.

Changing default preview mode to `composited-canvas` before fixing these would add risk without fixing zoom.

The CSS path is intentionally incremental:

- Minimal code surface.
- No export changes.
- No Rust changes.
- Existing native playback behavior stays intact.
- User gets immediate visual feedback when editing zoom clips.

## Follow-Up Plan After This Phase

Once native preview zoom is working:

1. Add a frontend preview-plan builder or IPC command that converts `computeGraph()` output into `PreviewRenderPlan`.
2. Replace `buildPlan()` in `PreviewPlayer` with a plan derived from timeline state.
3. Implement `sampleZoomMatrix(plan.zoom_matrices, t_ms)` in TypeScript.
4. Replace identity matrices in:
   - `webgpu-context.ts`
   - `webgl2-context.ts`
5. Add parity tests that prove compositor zoom uses `zoom_matrices`.
6. Only then consider defaulting preview to `composited-canvas`.

## Files Expected To Change In Phase 1

Likely:

- `apps/desktop/src/features/post-production/preview/preview-player.tsx`
- `apps/desktop/src/features/post-production/preview/__tests__/preview-player.test.tsx`

Possibly:

- None.

Avoid touching:

- `crates/effects/**`
- `apps/desktop/src-tauri/**`
- `packages/shared-types/**`
- Export modal code
- Timeline generation code

## Manual QA Checklist

1. Open Post Production for a story with a recording.
2. Switch to Fine Tune / Timeline Editing.
3. Add a zoom clip or use an existing script zoom.
4. Scrub before the clip: preview should be normal.
5. Scrub into the clip: preview should zoom around the configured center.
6. Scrub after the clip: preview should return to normal.
7. Press play across the clip: zoom should animate smoothly.
8. Verify cursor overlay does not visually detach from the zoomed video.
9. Verify export modal still opens and no export UI behavior changed.

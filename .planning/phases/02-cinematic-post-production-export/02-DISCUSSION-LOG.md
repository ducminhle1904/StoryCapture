# Phase 2: Cinematic Post-Production & Export - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 02-cinematic-post-production-export
**Areas discussed:** Preview rendering strategy, Auto-zoom & cursor 'feel', Timeline editor UX & undo, Export presets & sound library
**Mode:** discuss (interactive, Vietnamese)

---

## Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Preview rendering strategy | Real-time scrub engine choice | ✓ |
| Auto-zoom & cursor 'feel' | Pitfall #4/#5 quality decisions | ✓ |
| Timeline editor UX & undo | UI-05 + UI-11 design | ✓ |
| Export, presets & sound library | EXPORT-01..06 + POST-09 | ✓ |

User selected all 4 — full discussion conducted.

---

## Area 1: Preview rendering strategy

### Q1: Preview engine technology
| Option | Description | Selected |
|--------|-------------|----------|
| Two-engine: WebGPU/Canvas preview + FFmpeg final (Recommended) | 2 codepaths, smoothest UX | ✓ |
| Single-engine FFmpeg + proxy cache | Simpler but laggy scrub | |
| Hybrid: native renderer (Rust+wgpu) shared | Most powerful but huge scope | |

### Q2: Timeline scrub frame target
| Option | Description | Selected |
|--------|-------------|----------|
| 60fps interactive (Recommended) | Match Screen Studio | ✓ |
| 30fps acceptable | Lighter on GPU | |
| Best-effort + low-res placeholder | Simplest | |

### Q3: Final render strategy for non-FFmpeg-native effects
| Option | Description | Selected |
|--------|-------------|----------|
| Pure FFmpeg filter-graph | Simple distribution | |
| Pre-render overlays in Rust (image crate) → FFmpeg overlay (Recommended) | Balance flexibility + HW | ✓ |
| Custom Rust+wgpu renderer, FFmpeg encode-only | Most flexible, huge scope | |

### Q4: Background-render queue scope
| Option | Description | Selected |
|--------|-------------|----------|
| Multi-job queue with cancel/priority (Recommended) | Required by SC #4 | ✓ |
| Single in-flight job, non-blocking UI | Simpler but limited | |

---

## Area 2: Auto-zoom & cursor 'feel'

### Q1: Default auto-zoom preset
| Option | Description | Selected |
|--------|-------------|----------|
| Calm (Recommended) | 2.5x/800ms/2s/6per-min, Linear-style | |
| Dynamic | 3x/500ms/1.2s/10per-min, Screen Studio default | ✓ |
| Subtle (pan-only) | No zoom, safest | |

User picked Dynamic — prioritize Screen Studio polish for marketing demos.

### Q2: Cursor motion model
| Option | Description | Selected |
|--------|-------------|----------|
| Minimum-jerk trajectory (Recommended) | Flash 1985 model, most human-like | ✓ |
| Catmull-Rom spline + ease-in-out cubic | Simpler, looks "designed" | |
| Configurable (ship both, default minimum-jerk) | 2x test surface | |

### Q3: Custom cursor skins scope
| Option | Description | Selected |
|--------|-------------|----------|
| Bundle 3-4 skins + size scaling, no custom upload (Recommended) | Mac/Win/dark/light + big-arrow | ✓ |
| Single stylized default | Simplest, hard to compete | |
| Full custom upload + per-step override | Large scope | |

### Q4: Click ripple timing/style
| Option | Description | Selected |
|--------|-------------|----------|
| Anticipate 60ms before click + radial expand 300ms (Recommended) | Mimics human settle-before-click (Pitfall #4) | ✓ |
| Reactive only + 2-3 style options | Loom/Tella style | |
| Configurable timing + style | UI complexity | |

---

## Area 3: Timeline editor UX & undo

### Q1: Tracks layout
| Option | Description | Selected |
|--------|-------------|----------|
| 5 fixed tracks: Video / Cursor / Zoom / Sound / Annotations (Recommended) | Match SC #2 exactly | ✓ |
| 5 fixed + Sound sub-tracks (BGM/SFX/Voiceover) | More flexible audio | |
| Flexible: user add/remove unlimited (DAW-style) | Out of product scope | |

### Q2: Snapping & ripple-edit
| Option | Description | Selected |
|--------|-------------|----------|
| Magnetic snap (default ON, Alt = disable) + no ripple-edit (Recommended) | Simple for non-editors | ✓ |
| Magnetic snap + ripple-edit (Premiere-style) | Powerful but confusing | |
| Free-positioning, no snap | Poor precision UX | |

### Q3: Undo/redo granularity
| Option | Description | Selected |
|--------|-------------|----------|
| Per-action / coalesced (Recommended) | Match Figma/Sketch | ✓ |
| Per-keystroke / per-frame | Granular but bloated stack | |
| Snapshot-based | Coarse, loses changes | |

### Q4: Undo state storage
| Option | Description | Selected |
|--------|-------------|----------|
| In-memory ring buffer (50 steps), reset on reload (Recommended) | Most common, simple | ✓ |
| Persistent undo journal in project SQLite | Photoshop-style, more complex | |
| Hybrid: in-memory live + named persistent versions | Best of both, more UI | |

---

## Area 4: Export, presets & sound library

### Q1: Batch export pipeline
| Option | Description | Selected |
|--------|-------------|----------|
| Smart reuse: render composite frames once, encode N codecs (Recommended) | Fast, requires careful piping | ✓ |
| Independent jobs (simple) | Redundant work, isolated failures | |
| Two-pass: cache lossless intermediate (ProRes/FFV1) + encode from cache | Fastest re-export, disk-heavy | |

### Q2: Effect presets scope
| Option | Description | Selected |
|--------|-------------|----------|
| Per-project + global (export/import JSON) (Recommended) | Phase 2 sweet spot, web sync deferred | ✓ |
| Per-project only | Minimal POST-09, weak UX | |
| Per-project + global + auto-cloud sync | Out of scope (Phase 4) | |

### Q3: Sound library & BGM ducking
| Option | Description | Selected |
|--------|-------------|----------|
| Bundle small (10-15 SFX + 5-8 BGM, ~30MB) + auto-duck (Recommended) | One-click polish parity | ✓ |
| Bundle SFX only, BGM = user import | Lighter installer, mismatch expectation | |
| Library download on-demand (first editor open) | Avoid bloat, adds friction | |

### Q4: Background compositor scope
| Option | Description | Selected |
|--------|-------------|----------|
| 8-12 gradient presets + user image upload + rounded frame config (Recommended) | Logo/brand to Phase 4 | ✓ |
| 8-12 gradients only, no upload | Locked palette, low customization | |
| Full: gradient + image + per-project logo + brand kit | Org-level branding deferred to Phase 4 | |

---

## Follow-up Technical Decisions

### Q5: Preview render API
| Option | Description | Selected |
|--------|-------------|----------|
| WebGPU with WebGL2 fallback (Recommended) | Best perf, modern Tauri webview | ✓ |
| Canvas2D + ImageBitmap | Universal but slower at 4K | |
| Native overlay window (Rust+wgpu) | Highest perf, OS-specific complexity | |

### Q6: Effect AST + timeline state storage
| Option | Description | Selected |
|--------|-------------|----------|
| Project SQLite (project.sqlite from Phase 1) (Recommended) | Reuse Phase 1 D-27 pattern | ✓ |
| JSON file in project folder (effects.json) | Diffable but concurrency burden | |
| Both: SQLite truth + export JSON | Best of both, complex | |

---

## Claude's Discretion

- xfade duration defaults
- Text overlay easing curves
- Color palette gradients exact RGB
- FFmpeg sidecar pool size (start 2, configurable)
- Specific bundled sound files
- Sub-pixel jitter amplitude (0.5-1.5px range)
- Inspector panel UI layout details (UI-spec phase)
- Snapping threshold pixel distance

## Deferred Ideas

See CONTEXT.md `<deferred>` section — comprehensive list including AI voiceover (P3), web sync (P4), branded presets (P4), custom cursor upload, persistent undo, multi-viewport (v2), HDR (v2), native Rust+wgpu final renderer, DAW-style flexible tracks, real-time collab.

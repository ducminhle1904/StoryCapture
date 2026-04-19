# Phase 13: Video output customization knobs — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `13-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-19
**Phase:** 13 — Video output customization knobs — recording + export UI
**Areas discussed:** Recording UI placement, Preset vs individual knobs, Persistence scope & migration, HW encoder + Custom resolution, Pad color picker UX, Feedback & validation
**Area skipped by operator:** Export modal structure (Claude's discretion → progressive disclosure, CD-13-01)

---

## Gray area selection

| Area | Selected |
|---|---|
| Recording UI placement | ✓ |
| Preset vs individual knobs | ✓ |
| Export modal structure | |
| Persistence scope & migration | ✓ |
| HW encoder + Custom resolution | ✓ |
| Pad color picker UX | ✓ |
| Feedback & validation | ✓ |

**User's choice:** 6 of 7 areas. Export modal structure deferred to Claude's discretion.

---

## Recording UI placement

### Q1 — Where should the 5 knobs live?

| Option | Description | Selected |
|---|---|---|
| Inline 'Video Output' section in Recording Setup panel (Recommended) | Alongside AudioDevicePicker/CursorToggle/ChromeHidingToggle, same pattern, shown pre-record | ✓ |
| Collapsed 'Advanced' accordion | Hidden by default, user clicks to expand | |
| Separate 'Output settings' modal | One extra click; cleanest main UI | |

**User's choice:** Inline section (recommended).

### Q2 — Summary visibility near Record button?

| Option | Description | Selected |
|---|---|---|
| Always-visible badge (e.g. "1080p • 30fps • Letterbox • Med"), click to edit (Recommended) | Transparent without consuming space | ✓ |
| Only visible when panel/accordion open | Record button alone; setting hidden otherwise | |

**User's choice:** Always-visible badge (recommended).

---

## Preset vs individual knobs

### Q1 — How to expose the 5 recording knobs?

| Option | Description | Selected |
|---|---|---|
| Preset + override (Recommended) | Dropdown Standard/High Quality/Quick/Custom; overriding a knob auto-switches to Custom | ✓ |
| Presets only (3–4 choices) | No individual knobs visible | |
| 5 knobs only, no presets | Fully individual | |

**User's choice:** Preset + override (recommended).

### Q2 — Preset scope across recording and export?

| Option | Description | Selected |
|---|---|---|
| Shared preset pool (Recommended) | One preset definition drives both surfaces; export adds its own export-only knobs | ✓ |
| Separate recording preset vs export preset | Independent mental models | |

**User's choice:** Shared pool (recommended).

---

## Persistence scope & migration

### Q1 — What does tauri-plugin-store persist? (multiselect)

| Option | Description | Selected |
|---|---|---|
| Global defaults (preset + 5 knobs) (Recommended) | App-wide active preset and current knob values | ✓ |
| Per-project override (in .story folder) | Per-project override file; precedence project > global | ✓ |
| User-defined custom presets | Save-as "My 4K preset" pattern | |
| Last export-modal settings separate from preset | Separate memory for export-only knobs | |

**User's choice:** Global defaults + per-project override. User-defined custom presets and separate last-used deferred.

### Q2 — Migration path from Phase 12 hard-coded defaults?

| Option | Description | Selected |
|---|---|---|
| Silent seed with 1080p/30/Letterbox/Black/Med (Recommended) | No prompt; on first launch after upgrade, seed store to match Phase 12 behaviour | ✓ |
| Show "What's new" toast/modal once | Silent seed + one-time notification | |
| Prompt user to pick a preset first run | Blocking onboarding modal | |

**User's choice:** Silent seed (recommended).

---

## HW encoder + Custom resolution

### Q1 — HW encoder picker display?

| Option | Description | Selected |
|---|---|---|
| Auto + available-only (Recommended) | Probe-driven list; unavailable encoders hidden; includes Software (libx264) | ✓ |
| List all, grey out unavailable | Educational but heavier UI | |
| Auto only, no manual pick | No escape hatch for forcing libx264 | |

**User's choice:** Auto + available-only (recommended).

### Q2 — Custom resolution UX?

| Option | Description | Selected |
|---|---|---|
| 'Custom' option in dropdown reveals W×H inputs (Recommended) | Lazy-revealed; inline validation (even + 16..7680 × 16..4320) | ✓ |
| Presets + MatchSource only, no Custom | Drops the escape hatch | |
| Always-visible W×H inputs next to dropdown | Transparent but busy | |

**User's choice:** Lazy-revealed W×H (recommended).

---

## Pad color picker UX

### Q1 — Pad color picker control?

| Option | Description | Selected |
|---|---|---|
| Segmented Black/White/Custom + native color picker on Custom (Recommended) | 1:1 mapping to PadColor enum | ✓ |
| Swatch 6–8 presets (brand colors) | Nicer but needs brand palette management | |
| Black/White only (hide Custom) | Simplest | |

**User's choice:** Segmented + native picker (recommended).

### Q2 — Blur pad (deferred in Phase 12)?

| Option | Description | Selected |
|---|---|---|
| Hide entirely (Recommended) | No placeholder; add when backend lands | ✓ |
| Show "Blur (coming soon)" disabled | Promises without release date | |

**User's choice:** Hide entirely (recommended).

---

## Feedback & validation

### Q1 — Bitrate / file-size preview?

| Option | Description | Selected |
|---|---|---|
| Bitrate + est. file size per minute (Recommended) | Frontend-computed using Phase 12 pixel_based heuristic + quality multipliers | ✓ |
| Bitrate only, no file size | Avoids duration assumptions | |
| No preview | Let users discover | |

**User's choice:** Bitrate + file size per minute (recommended).

### Q2 — Warnings matrix (multiselect)?

First attempt (ambiguous): user selected all 4 options including both "all warnings" and "no warnings". Clarified with a follow-up.

**Follow-up:** "Which warnings do you actually want?"

| Option | Description | Selected |
|---|---|---|
| All 3 warnings (hard + 2 soft) (Recommended) | Custom res even (hard), Lossless+4K+HW (soft), Output>Capture no-upscale (soft) | ✓ |
| Hard validation only (Custom res even) | Drop both soft warnings | |
| Only no-upscale warning | Hard + no-upscale only | |

**User's choice:** All 3 warnings (recommended).

### Q3 — Live thumbnail preview of letterbox layout?

| Option | Description | Selected |
|---|---|---|
| No — defer (Recommended) | Out of phase scope | ✓ |
| ASCII/SVG static ratio mockup | Lightweight visual | |
| Live frame preview from capture | Requires capture side-channel | |

**User's choice:** Defer (recommended).

---

## Claude's Discretion (operator-skipped area)

- **Export modal structure:** operator skipped the gray area. Default → progressive disclosure (Basic section retains current flat form; "Show advanced" collapsible reveals the 8 export-only knobs). See CD-13-01 in CONTEXT.md.
- **Preset starter values:** initial tuples for Quick/Standard/High Quality are best-guess; planner may refine.
- **Vietnamese copywriting:** all user-facing strings in Vietnamese; wording to be finalized in planning/execution.
- **Export-only knob defaults:** Container/Codec/Rate control/HW encoder/Preset/Keyframe/Downscale/Audio defaults anchored to Phase 12 behaviour; planner to confirm numbers.

## Deferred Ideas (surfaced during discussion)

- User-defined named presets (save-as "My 4K preset")
- Separate last-used memory for export-only knobs
- Blur-source pad UI (wait on Phase 12 backend)
- Live frame-based thumbnail / letterbox preview
- FPS split (carried from Phase 12 D-12-09)
- HEVC/VP9/AV1 codec switching, container switching, custom x264 opts passthrough
- Onboarding modal / "What's new" toast
- Grey-out unavailable HW encoders with tooltip

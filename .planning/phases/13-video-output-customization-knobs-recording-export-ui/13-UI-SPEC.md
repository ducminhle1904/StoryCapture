---
phase: 13
slug: video-output-customization-knobs-recording-export-ui
status: draft
shadcn_initialized: true
preset: "new-york + base-ui registry (base-vega-equivalent)"
created: 2026-04-19
---

# Phase 13 — UI Design Contract

> Visual and interaction contract for the recording-time Video Output section, the export-modal Advanced disclosure, the shared preset/summary badge, and the output-prefs persistence surface. Consumes Phase 12 backend DTOs; adds zero new IPC commands (only one optional extension to `ExportOutputDto`).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn (initialized — `apps/desktop/components.json`) |
| Preset | `style: new-york`, `baseColor: zinc`, `cssVariables: true`, `registries: ["base-ui"]` |
| Component library | Base UI (`@base-ui-components/react` 1.x beta) — NOT Radix |
| Icon library | `lucide-react` 0.460+ |
| Font | Display/Sans: Inter (fallback: system-ui). Serif: Lora. Mono: JetBrains Mono. Per `packages/ui/src/tokens.css`. |
| Theme tokens | Live in `packages/ui/src/tokens.css` (Tailwind v4 `@theme`). Cream/warm-near-black light + warm dark mode. |
| Animation | `motion/react` (Motion 12.x). Must respect `useReducedMotion()` for every animated surface. |

---

## Spacing Scale

Project uses Tailwind v4 default 4-point scale (`space-1 = 4px`). Phase 13 declares the following subset:

| Token | Value | Usage in Phase 13 |
|-------|-------|-------------------|
| xs | 4px | Inline icon↔label gap, chip paddings |
| sm | 8px | Form-row vertical rhythm, inline-warning gap |
| md | 16px | Default control↔control spacing inside a knob group |
| lg | 24px | Section padding, gap between knob groups |
| xl | 32px | Divider between `Video Output` section and neighbour pickers |
| 2xl | 48px | (not used in this phase) |
| 3xl | 64px | (not used in this phase) |

**Exceptions for Phase 13:** none. The native `<input type="color">` renders at its OS default height (~32–40px) which does not round to a 4-multiple on every platform; wrap it in a flex row with `gap-2` and accept the OS-given height as a documented pragma.

**Minimum hit targets:**
- Segmented-control buttons: `h-9 px-3` (36×≥36, meets 36px Base UI default; 44px not required for desktop mouse target but keep ≥36px).
- Record-button-adjacent summary badge: `h-8 px-3` (32px, `rounded-[var(--radius-pill)]`) — it is a clickable chip with 8px padding to the Record CTA.

---

## Typography

Three voices exist in the project (display, serif, mono). Phase 13 uses **display only** (no serif, no mono except the live bitrate figure which renders in mono for stability against digit width jitter).

| Role | Size | Weight | Line Height | Font | Usage |
|------|------|--------|-------------|------|-------|
| Section title | 16px | 600 (semibold) | 1.2 | display (Inter) | `Video Output`, `Advanced export options` |
| Knob label | 13px | 500 (medium) | 1.3 | display | Every form control label (`Resolution`, `FPS`, …) |
| Body / helper | 13px | 400 (regular) | 1.5 | display | Helper text under a knob, warning copy |
| Numeric readout | 13px | 500 (medium) | 1.3 | **mono (JetBrains Mono)** | `~8.3 Mbps • ~60 MB/min`, `1280×720` custom dims, hex `#rrggbb` |

Summary badge uses `12px / 500 / 1.2 / display`, tabular for `•` separators.

**Weight pair:** 400 (regular) + 500 (medium) for body/label hierarchy; 600 (semibold) allowed on section titles only — this stays within the "2 primary weights, 1 emphasis" limit.

---

## Color

Project is a 60/30/10 warm-cream system. Phase 13 adds NO new hues; it reuses `tokens.css` tokens exclusively.

| Role | Token / Value | Usage in Phase 13 |
|------|---------------|-------------------|
| Dominant (60%) | `--color-bg-primary` (`#f2f1ed` light / `#1c1b18` dark) | Recording panel + Export modal background |
| Secondary (30%) | `--color-bg-surface` (`#e6e5e0` / `#26251e`) + `--color-surface-300` | Knob-group card, Advanced disclosure inner surface, summary-badge background |
| Accent (10%) | `--color-accent-primary` (`#f54e00` / `#ff6b2d`) | **Reserved for exactly these elements in Phase 13:** (1) active state of the `Preset` select trigger when not `Custom`, (2) the chevron-rotate on the open Advanced accordion, (3) focus ring (`--color-focus-ring`), (4) the "active" segment of the pad-color segmented control |
| Destructive | `--color-danger` (`#cf2d56` / `#e84672`) | Hard-validation error text + input border on Custom W/H out-of-range; never used on a button in this phase (no destructive action here) |
| Warning | `--color-warning` (`#c08532` / `#d4a04a`) | Soft-warning inline note icon + left border stripe (lossless+4K+HW, output>capture) |
| Info | `--color-timeline-read` (`#9fbbe0`) | Bitrate/file-size preview label left stripe |
| Success | `--color-success` (`#1f8a65` / `#2aad7a`) | "HW encoder available" check icon in HW encoder select popover list |

**Accent reserved for** (explicit list — never "all interactive elements"):
1. Active preset indicator (select trigger text color when `activePreset !== "Custom"`).
2. Active segment of the Pad Color segmented control.
3. Open-state chevron on the Advanced accordion.
4. Focus ring on every interactive control (inherits `--color-focus-ring` = accent).

Everything else uses neutral (`--color-fg-primary`, `--color-fg-secondary`, `--color-bg-elevated`).

---

## Component Inventory

### Primitives to scaffold (shadcn Base UI registry, style `new-york`)

Run once in Plan 13-01:

```bash
cd apps/desktop
pnpm dlx shadcn@latest add accordion toggle-group radio-group slider input label
```

| Primitive | Registry Source | Purpose in Phase 13 |
|-----------|-----------------|---------------------|
| `accordion.tsx` | base-ui | Advanced export disclosure (collapsed by default) |
| `toggle-group.tsx` | base-ui | Pad-color segmented (`Black`/`White`/`Custom`), Fit-mode segmented (`Letterbox`/`Pillarbox`/`Crop`/`Stretch`) |
| `radio-group.tsx` | base-ui | FPS picker (`24`/`30`/`60`), Rate-control picker (`CBR`/`VBR`/`CRF`/`CQ`), Downscale-algo picker (`Lanczos`/`Bicubic`/`Bilinear`) |
| `slider.tsx` | base-ui | CRF (0–51), CQ (0–51), bitrate Mbps (1–50) |
| `input.tsx` | base-ui | Custom W/H (number), keyframe interval (number), hex text input synced with color input |
| `label.tsx` | base-ui | Accessible label primitive for every control |

### Primitives to author (Phase 13 bespoke, no registry equivalent)

| Component | File (new) | Notes |
|-----------|-----------|-------|
| `ColorField` | `components/ui/color-field.tsx` | Wraps native `<input type="color">` + text input (lowercase `#rrggbb`). Two-way-sync via shared onChange. No external dep. |
| `NumberField` | `components/ui/number-field.tsx` | Thin wrapper over `Input` with numeric parsing, step, min/max, and inline `aria-invalid` + error-id wiring. Reuses `Input` primitive. |
| `OutputSummaryBadge` | `features/recorder/video-output/output-summary-badge.tsx` | Pill chip; copy `1080p • 30fps • Letterbox • Med` (see Copywriting). `onClick` scrolls `#video-output-section` into view + moves focus to `Preset` trigger. |
| `VideoOutputSection` | `features/recorder/video-output/video-output-section.tsx` | Container for the 5 recording knobs + preset-select + bitrate preview + warnings. Mirrors `AudioDevicePicker` / `CursorToggle` layout rhythm exactly (same header typography, same 16px gap between rows, same `--color-surface-300` card). |
| `AdvancedOutputOptions` | `features/post-production/export-modal/advanced-output-options.tsx` | Accordion body containing 8 export-only knobs grouped into three logical sub-groups (see Layout Spec). |
| `BitratePreview` | `features/recorder/video-output/bitrate-preview.tsx` | Pure-presentational; renders `~{mbps} Mbps • ~{mbPerMin} MB/min`. Mono font. Info stripe on left. |
| `WarningNote` | `features/recorder/video-output/warnings.tsx` | Two variants: `error` (destructive stripe + icon) and `warn` (warning stripe + icon). `aria-live="polite"` for soft; hard errors associate via `aria-describedby` to the invalid field. |

---

## Layout Spec

### Recording View — `<VideoOutputSection>` (5 knobs)

Placement: inside the Recording Setup panel of `apps/desktop/src/features/recorder/recording-view.tsx`, slotted **after** `ChromeHidingToggle` and **before** the Record CTA. Minimum container width is the Recorder window min-width (800px); component must render correctly down to **640px** content width (the recording panel inner width at min window).

```
┌─ Video Output (section title 16/600) ─────────────────── [ Preset ▾ ] ─┐
│                                                                          │
│  Resolution       [ 1080p                      ▾ ]                       │
│  └ (if Custom)    [W 1920][×][H 1080]   helper: "chẵn, 16–7680 × 16–4320"│
│                                                                          │
│  FPS              ( ) 24    (•) 30    ( ) 60       ← radio-group row     │
│                                                                          │
│  Fit              [ Letterbox │ Pillarbox │ Crop │ Stretch ]  ← toggle   │
│                                                                          │
│  Pad color        [ Black │ White │ Custom ]                             │
│  └ (if Custom)    [■ color]  #ff6b2d                                     │
│                                                                          │
│  Quality          ( ) Low  (•) Med  ( ) High  ( ) Lossless               │
│                                                                          │
│  ┌─ info stripe ─────────────────────────────────────────────────────┐  │
│  │  ~8.3 Mbps • ~60 MB/min                                           │  │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  [optional warning rows — see Warning States]                            │
└──────────────────────────────────────────────────────────────────────────┘
```

Layout rules:
- Root: `flex flex-col gap-4` (16px row rhythm).
- Each knob row: `grid grid-cols-[120px_1fr] gap-4 items-center`. Label column 120px. Below 640px, collapse to `grid-cols-1 gap-1` (stacked). Label stays left-aligned in stacked mode.
- Preset select sits top-right of the section header, visually aligned with the section title baseline.
- Custom reveals (W/H, hex, color input) animate height+opacity via `motion.div` — duration 160ms, ease `[0.22, 0.61, 0.36, 1]`. Skip animation under `useReducedMotion()`.
- Section card: `bg-[var(--color-surface-300)] rounded-[var(--radius-lg)] p-6 border border-[var(--color-border-subtle)]`.

### Summary Badge placement

Rendered inline with the Record button header row. Spacing: `gap-3` between badge and Record CTA. Badge has `max-w-[220px]` and `truncate` — if content exceeds, truncate the quality segment first (least critical).

```
[ ● Record ]   1080p • 30fps • Letterbox • Med  ▸
                                                ^ chevron icon indicates clickability
```

### Export Modal — `<AdvancedOutputOptions>` (8 knobs)

Placement: inside `export-modal.tsx`, rendered after the existing `resolution-picker` + `format-checkboxes` (the Basic surface), before the modal footer actions. Renders as a single Base UI `Accordion` with one item (label: `Tùy chọn nâng cao`), collapsed by default.

Inner layout uses three visual sub-groups separated by `border-t border-[var(--color-border-subtle)] pt-4 mt-4`:

**Group 1 — Container & Codec** (always visible when accordion open)
- Container: `Select` — options `MP4`, `MOV`, `WebM` (gated by Phase 12 `EncodeConfig`).
- Codec: `Select` — options dependent on Container (MP4/MOV → H.264; WebM → disabled for Phase 13, show `libopenh264 (WebM — deferred)` as a muted, disabled option).

**Group 2 — Encoder & Quality** (conditional fields — see Conditional Field Decision Table)
- HW encoder: `Select` — first option `Auto`, then probed-available encoders, then `Software (libx264)` last.
- Rate control: `RadioGroup` horizontal — options depend on encoder (see decision table).
- Quality knob: **Conditional** — `Slider` (CRF/CQ) OR `NumberField` (bitrate Mbps) OR disabled label.
- Preset: `Select` — options depend on encoder (libx264: `ultrafast..veryslow`; NVENC: `p1..p7`; VideoToolbox: `speed`/`quality`; QSV: `veryfast..slower`; AMF: `speed`/`balanced`/`quality`).

**Group 3 — Keyframe, Downscale, Audio**
- Keyframe interval: `NumberField` (seconds, 1–10, default 2).
- Downscale algo: `RadioGroup` — `Lanczos` / `Bicubic` / `Bilinear`.
- Audio codec: `Select` — `AAC` (default), `Opus` (WebM only — disabled otherwise).
- Audio bitrate: `Slider` 64–320 kbps in 32-kbps steps; default 160.
- Audio channels: `RadioGroup` — `Mono` / `Stereo`; default Stereo.

Layout rules:
- Modal min content width: 600px. Advanced accordion renders at 2-column `grid-cols-2 gap-x-6 gap-y-4` for knob rows (label above control). Below 560px (narrow modal variant if ever), collapse to 1-column.
- Each sub-group has its own label row `text-[13px] font-medium text-[var(--color-fg-secondary)] uppercase tracking-wide mb-2`.

---

## Conditional Field Decision Table

Planner implements this as a pure function `deriveQualityControls(encoder, codec)` returning `{ rateControlOptions, qualityControl, presetOptions, notes }`. The executor renders whichever control the table specifies.

| HW Encoder | Default Rate Control | Quality Control | Preset Options | Extra Notes / Locks |
|-----------|---------------------|-----------------|----------------|---------------------|
| `h264_videotoolbox` | `VBR` (only option) | **NumberField**: bitrate (Mbps 1–50) + `maxrate` + `bufsize` derived (read-only mono readout) | `speed` / `quality` (2 options) | Hide CRF/CQ sliders entirely |
| `hevc_videotoolbox` | `VBR` (only option) | NumberField: bitrate Mbps | `speed` / `quality` | Same as H.264 VT |
| `h264_nvenc` | `VBR` (locked) — radio group shown disabled for affordance | **Slider**: CQ 0–51 (default 19) + preset | `p1`..`p7` (default `p5`) | Hide CRF; show note "NVENC uses CQ as VBR target" |
| `hevc_nvenc` | `VBR` (locked) | Slider: CQ 0–51 | `p1..p7` | Same as h264_nvenc |
| `h264_qsv` | `VBR` / `CBR` | NumberField: bitrate Mbps | `veryfast..slower` | QSV CQP exists but not exposed in Phase 13 |
| `h264_amf` | `VBR` / `CBR` | NumberField: bitrate Mbps | `speed` / `balanced` / `quality` | — |
| `libx264` (Software) | `CRF` (default) / `CBR` / `VBR` | **Slider**: CRF 0–51 (default 18) | `ultrafast..veryslow` (default `medium`) | `tune=stillimage` is locked-on in backend (Phase 12); show as a read-only note: "Đã bật `tune=stillimage`" |
| `libopenh264` (fallback) | `CBR` (only) | NumberField: bitrate Mbps (default 4) | (none — hide preset select) | Show warning: "Fallback encoder — không có preset tuning" |
| `Auto` | — | — | — | Render as "Encoder sẽ được chọn lúc export" explanatory note; hide all quality/preset controls until user selects a concrete encoder OR show a shadow read-only preview of the `Software (libx264)` defaults |

**Unavailability:** If the HW encoder the user previously persisted is NOT in the current `probe_hw_encoders()` result, the select shows it as the selected value with suffix `(không khả dụng trên máy này)` and a soft warning appears: `"Encoder này không có sẵn. Chọn Auto hoặc Software."` The user can still submit, and backend will fall back per Phase 12 contract — but the warning is persistent until resolved.

---

## Motion / Animation

All animations use `motion/react`. Respect `useReducedMotion()` — when true, replace duration with `0` and skip transforms.

| Surface | Animation | Duration | Ease | Reduced-motion fallback |
|---------|-----------|----------|------|--------------------------|
| Accordion expand (Advanced export) | height auto + opacity 0→1 | 180ms | `[0.22, 0.61, 0.36, 1]` | Instant toggle; no fade |
| Custom-reveal rows (W/H inputs, hex/color) | height + opacity | 160ms | same | Instant |
| Summary badge click → scroll-into-view | `scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" })` | — | — | `behavior: "auto"` |
| Preset change → knob value animation | **None** — values update instantly | 0 | — | Same |
| Warning row enter/exit | opacity + translateY(-4px → 0) | 140ms | linear | Instant |
| Pad-color segmented active indicator | transform translateX | 150ms | `[0.4, 0, 0.2, 1]` | Instant snap |

No layout shifts allowed: reserve vertical space for the bitrate-preview strip (40px) so its value updates don't push warnings.

---

## Copywriting Contract

All user-facing strings in Vietnamese (per CD-13-03). Centralize in `apps/desktop/src/features/recorder/video-output/copy.ts` and `.../export-modal/advanced-copy.ts`.

### Primary CTA

No new CTA is introduced by Phase 13 — the existing `Record` CTA (in `recording-view.tsx`) and `Export` CTA (in `export-modal.tsx`) remain unchanged. Phase 13 only adds controls that feed them.

### Section titles & knob labels

| Element | Copy (VN) |
|---------|-----------|
| Recording section title | `Đầu ra video` |
| Preset select label | `Preset` |
| Preset options | `Nhanh` / `Tiêu chuẩn` / `Chất lượng cao` / `Tùy chỉnh` |
| Resolution | `Độ phân giải` |
| Resolution options | `720p` / `1080p` / `1440p` / `4K` / `Khớp với nguồn` / `Tùy chỉnh…` |
| Custom W / H | `Rộng` / `Cao` |
| Custom W/H helper | `Chẵn, 16–7680 × 16–4320` |
| FPS | `FPS` |
| Fit mode | `Chế độ lấp khung` |
| Fit options | `Letterbox` / `Pillarbox` / `Cắt` / `Kéo giãn` |
| Pad color | `Màu viền` |
| Pad options | `Đen` / `Trắng` / `Tùy chỉnh` |
| Quality | `Chất lượng` |
| Quality options | `Thấp` / `Trung bình` / `Cao` / `Lossless` |
| Export advanced accordion trigger | `Tùy chọn nâng cao` |
| Container | `Định dạng tệp` |
| Codec | `Codec` |
| HW encoder | `Bộ mã hóa phần cứng` |
| Rate control | `Kiểm soát bitrate` |
| Quality slider (CRF/CQ) | `Chất lượng (thấp hơn = tốt hơn)` |
| Bitrate number | `Bitrate (Mbps)` |
| Preset (encoder) | `Tốc độ mã hóa` |
| Keyframe | `Khoảng keyframe (giây)` |
| Downscale algo | `Thuật toán giảm kích thước` |
| Audio codec | `Codec âm thanh` |
| Audio bitrate | `Bitrate âm thanh` |
| Audio channels | `Kênh` + options `Mono` / `Stereo` |

### Summary badge

- Default format: `{res} • {fps}fps • {fit} • {quality}` — example `1080p • 30fps • Letterbox • Trung bình`
- Custom resolution: render literal dims — `1280×720 • 30fps • Letterbox • Trung bình`
- Non-default pad color: append the pad color segment — `… • Viền Trắng` (only when pad ≠ Black).
- Tooltip on hover: `Nhấn để xem chi tiết đầu ra video`

### Preview strip

- Format: `~{mbps} Mbps • ~{mb_per_min} MB/phút` (one decimal for Mbps, integer for MB).
- Loading/indeterminate (only during first mount if `useOutputPrefsStore` hasn't hydrated): `Đang tính…` in muted foreground — this is expected to be <100ms so in practice it rarely renders.

### Warning states (matrix)

| Trigger | Severity | Copy | Association |
|---------|----------|------|-------------|
| Custom W or H not even, or outside 16–7680 / 16–4320 | HARD error | `Chiều rộng/cao phải là số chẵn và trong khoảng 16–7680 × 16–4320.` | `aria-describedby` on the failing input; disables Record/Export submit |
| `Lossless` + output ≥ 4K pixels + any HW encoder | SOFT warn | `Chất lượng Lossless ở 4K với HW encoder có thể vượt bitrate cap phần cứng và khiến render chậm. Cân nhắc giảm xuống Cao hoặc chuyển sang Software (libx264).` | `aria-live="polite"` region below knob group |
| Output dims > capture dims on any axis | SOFT warn | `Nguồn ghi nhỏ hơn kích thước output — video sẽ giữ nguyên kích thước nguồn và thêm viền thay vì phóng to (không làm mờ text).` | Same polite live region |
| Persisted HW encoder not present in current probe | SOFT warn | `Bộ mã hóa {name} không có sẵn trên máy này. Chọn Auto hoặc Software (libx264).` | Below encoder select |
| First-launch post-migration (silent, per D-13-06) | — | **No copy** — silent seed per D-13-06 | — |

### Empty / loading states

- **HW encoder probe loading** (first open of export Advanced): `Đang dò bộ mã hóa…` muted text inside the select popover for up to 500ms; then replaced by list. No spinner (matches AudioDevicePicker pattern).
- **HW encoder probe empty result**: not possible — `Software (libx264)` is always appended. If the probe itself fails (IPC error), show: `Không dò được bộ mã hóa phần cứng. Dùng Software (libx264).` as a soft warning and hard-select `Software`.
- **Per-project override read failure**: silent — fall through to global + toast once via `sonner`: `Không đọc được tùy chọn riêng của dự án. Đang dùng mặc định chung.`
- **Per-project override write failure**: `sonner.error("Không lưu được tùy chọn vào dự án.")` + keep the in-memory change (not dropped).

### Destructive actions

Phase 13 has **no destructive actions**. The Preset "Custom → apply Standard" flow overrides the user's custom knob values but is reversible within session (undo not required by D-13-03). If a concern surfaces during planning that applying a preset over a heavily customized Custom bundle should confirm, raise it as a follow-up — Phase 13 does not require a confirm dialog.

---

## Accessibility Contract

| Requirement | Implementation |
|-------------|----------------|
| WCAG 2.1 AA color contrast | All text on `--color-surface-300` / `--color-surface-100` backgrounds uses `--color-fg-primary` (contrast ≥ 11:1 in light, ≥ 13:1 in dark). Warning/error text uses dedicated tokens verified to hit ≥ 4.5:1 against card background. |
| Keyboard navigation | Tab order: Preset → Resolution → (Custom W → Custom H) → FPS radio group → Fit toggle group → Pad toggle → (Custom color input → hex text) → Quality radio group → first warning (if any). Export Advanced: accordion trigger → first control inside → … → last control. |
| Segmented / toggle-group | Base UI `ToggleGroup` — arrow keys move between segments, Home/End jump to ends, Space/Enter activates. |
| Radio groups | Base UI `RadioGroup` — arrow keys move + auto-select per ARIA APG. |
| Slider | Base UI `Slider` — arrow keys ±1, Shift+arrow ±10, PageUp/Down ±10, Home/End jump to min/max. |
| Labels | Every control wrapped in `<Label htmlFor="…">` or uses `aria-labelledby`. No placeholder-as-label. |
| Error association | Hard-error inputs get `aria-invalid="true"` + `aria-describedby="{id}-error"`; the error node has matching id. |
| Soft-warning live region | `role="status" aria-live="polite"` container shared for all soft warnings; new warnings announce once, not on every re-render (use `key={warningId}` stability). |
| HW encoder availability announcement | The probe completion announces once via a hidden `aria-live="polite"` region: `"{N} bộ mã hóa phần cứng khả dụng."` Only on first render per session. |
| Reduced motion | `useReducedMotion()` gates every `motion.*` surface per Motion section. |
| Focus visible | All controls inherit `focus-visible:shadow-[var(--shadow-focus)]` + accent-colored focus ring via `--color-focus-ring`. |
| Minimum target | ≥ 36×36 for all clickable controls (segmented buttons, summary badge, color swatch trigger). |

---

## Responsive Behavior

| Surface | Breakpoint | Behavior |
|---------|-----------|----------|
| Recording panel | ≥ 800px window / ≥ 640px content | 2-column label-left layout as spec'd |
| Recording panel | < 640px content (not expected in v1 — Recorder window has 800px min) | Stacked 1-column, label above control |
| Summary badge | — | `max-w-[220px]` truncation; Quality segment drops first, Fit drops second, FPS drops third; Resolution never drops |
| Export modal | ≥ 600px | 2-column grid inside Advanced accordion |
| Export modal | < 560px (rare) | 1-column stack |

---

## State matrix (per knob group)

| State | Visual | Copy |
|-------|--------|------|
| Default / normal | Neutral controls, info stripe shows live bitrate | standard labels |
| Hydrating (<100ms) | Controls rendered with persisted values before hydration; if mid-flight, use Phase 12 defaults | `Đang tính…` in preview strip |
| Custom preset | Preset select shows `Tùy chỉnh` in `--color-fg-primary` (no accent — accent reserved for the 3 named presets) | — |
| Named preset active | Preset select text colored `--color-accent-primary` | — |
| Hard-invalid (Custom W/H) | Input has `border-[var(--color-danger)]` + `aria-invalid` + destructive-colored helper | Error copy (see matrix) |
| Soft-warn | Warning row below knob group with `--color-warning` left stripe + `TriangleAlert` icon (Lucide, 14px) | Warning copy |
| HW unavailable (persisted) | Select trigger shows encoder name + `(không khả dụng)` suffix in muted | Soft warning row |
| Loading probe | Select popover shows `Đang dò…` muted | — |
| Per-project override active | Small `Sparkles` icon (Lucide 12px) in section title row with tooltip `Tùy chọn riêng của dự án đang ghi đè mặc định chung.` | Tooltip copy |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official (via `base-ui` registry configured in `components.json`) | `accordion`, `toggle-group`, `radio-group`, `slider`, `input`, `label` | not required — official shadcn registry, already trusted by project (existing `select.tsx` and `button.tsx` follow the same pipeline) |
| Third-party registries | none | not applicable |

No third-party registries are introduced in Phase 13. The registry vetting gate does not apply.

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

---

## Appendix — Sources of each decision

| Decision | Source |
|----------|--------|
| Design system = shadcn new-york + base-ui registry | `apps/desktop/components.json` |
| Token palette (cream/warm-dark) | `packages/ui/src/tokens.css` |
| Font trio + 3-voice hierarchy | `packages/ui/src/tokens.css` header comment |
| Button primitive deviation (CVA) | `apps/desktop/src/components/ui/button.tsx` header doc |
| 5 recording knobs + segmented pad + custom color | CONTEXT.md D-13-01, D-13-08, D-13-09 |
| Preset model + Custom-auto-flip | CONTEXT.md D-13-03 |
| Shared preset pool recording↔export | CONTEXT.md D-13-04; RESEARCH.md "Preset state architecture" |
| Advanced accordion for export | CONTEXT.md CD-13-01 |
| HW encoder list via probe + hide-unavailable | CONTEXT.md D-13-07 |
| Bitrate + file-size preview formula | CONTEXT.md D-13-11 + specifics block |
| Hard + soft warning matrix | CONTEXT.md D-13-12 + specifics block (VN copy) |
| Silent migration from Phase 12 defaults | CONTEXT.md D-13-06 |
| Vietnamese copy everywhere | CONTEXT.md CD-13-03 |
| Per-encoder quality mapping | RESEARCH.md + Phase 12 D-12-04 + additional_context decision table |
| Zustand slice at `state/output-prefs.ts` (neutral) | RESEARCH.md Architecture section + additional_context |
| Motion respect for reduced-motion | Project-wide convention (CLAUDE.md + existing `dialog-motion.ts` pattern) |

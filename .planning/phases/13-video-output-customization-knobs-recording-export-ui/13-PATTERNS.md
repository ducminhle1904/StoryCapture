# Phase 13: Video output customization knobs — Pattern Map

**Mapped:** 2026-04-19
**Files analyzed:** 18 new + 6 modified
**Analogs found:** 22 / 24 (2 require greenfield design — `tauri-plugin-store` singleton + per-project JSON adapter)

---

## File Classification

### NEW files

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `apps/desktop/src/state/output-prefs.ts` | shared Zustand store (cross-feature) | request-response (selectors) | `apps/desktop/src/features/post-production/state/store.ts` (slice composition exception) + `apps/desktop/src/state/recorder.ts` (single-feature monolith) | role-match (hybrid) |
| `apps/desktop/src/lib/output-prefs-persist.ts` | persistence + migrator | file-I/O (KV store) | `apps/desktop/src/lib/theme.ts` (localStorage singleton) + `crates/storage/src/preset_io.rs` (versioned migrator pattern) | role-match (no plugin-store precedent in repo) |
| `apps/desktop/src/ipc/output-prefs.ts` | TS wrapper around `@tauri-apps/plugin-store` | request-response | `apps/desktop/src/ipc/encode.ts` (thin invoke wrapper) | role-match (no plugin-store precedent) |
| `apps/desktop/src/components/ui/accordion.tsx` | scaffolded primitive (Base UI) | UI | `apps/desktop/src/components/ui/select.tsx` | exact (shadcn-Base UI scaffold) |
| `apps/desktop/src/components/ui/toggle-group.tsx` | scaffolded primitive | UI | same as above | exact |
| `apps/desktop/src/components/ui/radio-group.tsx` | scaffolded primitive | UI | same as above | exact |
| `apps/desktop/src/components/ui/slider.tsx` | scaffolded primitive | UI | same as above | exact |
| `apps/desktop/src/components/ui/input.tsx` | scaffolded primitive | UI | same as above | exact |
| `apps/desktop/src/components/ui/label.tsx` | scaffolded primitive | UI | same as above | exact |
| `apps/desktop/src/components/ui/color-field.tsx` | bespoke wrapper | UI | `apps/desktop/src/features/recorder/CursorToggle.tsx` (small bespoke control) | role-match |
| `apps/desktop/src/components/ui/number-field.tsx` | bespoke wrapper | UI | `apps/desktop/src/components/ui/select.tsx` (forwardRef + cn pattern) | role-match |
| `apps/desktop/src/features/recorder/video-output/video-output-section.tsx` | section container | UI | `apps/desktop/src/features/recorder/AudioDevicePicker.tsx` + the `SettingsGroup` rhythm in `recording-view.tsx:760-835` | exact |
| `apps/desktop/src/features/recorder/video-output/preset-select.tsx` | controller (Select binding) | request-response | `AudioDevicePicker.tsx` (Base UI Select + `kind:payload` round-trip) | exact |
| `apps/desktop/src/features/recorder/video-output/resolution-control.tsx` | controller (Select + reveal) | request-response | `AudioDevicePicker.tsx` + `ChromeHidingToggle.tsx` (conditional disable) | exact |
| `apps/desktop/src/features/recorder/video-output/fps-control.tsx` | controller (radio group) | request-response | `format-checkboxes.tsx` (sr-only input + label-as-button) | exact |
| `apps/desktop/src/features/recorder/video-output/fit-mode-control.tsx` | controller (toggle group) | request-response | `resolution-picker.tsx` (segmented label-as-button) | exact |
| `apps/desktop/src/features/recorder/video-output/pad-color-control.tsx` | controller (segmented + color reveal) | request-response | `resolution-picker.tsx` (segmented) + `CursorToggle.tsx` (label rhythm) | role-match |
| `apps/desktop/src/features/recorder/video-output/quality-preset-control.tsx` | controller (radio group) | request-response | `resolution-picker.tsx` | exact |
| `apps/desktop/src/features/recorder/video-output/bitrate-preview.tsx` | pure presentational | derived | `recording-view.tsx` `LiveRecordingBadge` (line 856+, mono inline pill) | role-match |
| `apps/desktop/src/features/recorder/video-output/warnings.tsx` | presentational + a11y | derived | `export-modal.tsx:67` `warnings: string[]` + `TriangleAlert` icon (lines 22-28) | role-match |
| `apps/desktop/src/features/recorder/video-output/output-summary-badge.tsx` | derived chip | derived | `recording-view.tsx` `LiveRecordingBadge` (line 856+) | role-match |
| `apps/desktop/src/features/recorder/video-output/copy.ts` | i18n constants | static | (no precedent — first centralized copy module) | no analog |
| `apps/desktop/src/features/post-production/export-modal/advanced-output-options.tsx` | section container | UI | `export-modal.tsx:244-335` (section rhythm) | role-match |

### MODIFIED files

| Modified File | Role | Data Flow | Closest Analog (for new code added here) | Match Quality |
|----|----|----|----|----|
| `apps/desktop/src/features/recorder/recording-view.tsx` | controller (host of new section + badge) | request-response | self — existing `SettingsGroup` slot at lines 793-835 | exact (in-file) |
| `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` | controller (host of Advanced disclosure) | request-response | self — existing `<section>` rhythm at lines 244-335 | exact (in-file) |
| `apps/desktop/src/features/post-production/state/export-slice.ts` | Zustand slice extension | state | self + `recorder.ts` setter rhythm | exact |
| `apps/desktop/src/ipc/encode.ts` | IPC wrapper extension | request-response | self — existing `StartRecordingArgs` optional fields lines 22-35 | exact |
| `apps/desktop/src/ipc/export.ts` | IPC wrapper extension | request-response | self — existing `ExportOutput` shape lines 15-31 | exact |
| `apps/desktop/src-tauri/src/lib.rs` | plugin registration (one line) | bootstrap | self — existing plugin chain lines 102-114 | exact |

---

## Pattern Assignments

### `state/output-prefs.ts` (shared Zustand store, cross-feature)

**Primary analog:** `apps/desktop/src/features/post-production/state/store.ts` (lines 19-69) — documented slice-composition exception.
**Secondary analog:** `apps/desktop/src/state/recorder.ts` (lines 135-167) — single-feature monolithic shape.

**Imports + composition pattern** (from `store.ts:19-34`):
```ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createExportSlice, type ExportSlice } from "./export-slice";
import { createPanelsSlice, PANELS_STORAGE_KEY, type PanelsSlice } from "./panels-slice";
// ...

export type EditorStore = TimelineSlice &
  PanelsSlice &
  SelectionSlice &
  ExportSlice &
  QueueSlice &
  UndoSlice;
```

**Setter rhythm** (from `recorder.ts:163-166`):
```ts
reset: () => set({ ...INITIAL }),
setAudioDeviceId: (audioDeviceId) => set({ audioDeviceId }),
setIncludeCursor: (includeCursor) => set({ includeCursor }),
setChromeHiding: (chromeHiding) => set({ chromeHiding }),
```

**Slice creator signature** (from `export-slice.ts:45-61`):
```ts
export const createExportSlice: StateCreator<ExportSlice, [], [], ExportSlice> = (
  set,
) => ({
  exportForm: { ...DEFAULT_FORM },
  setExportFormats: (formats) =>
    set((s) => ({ exportForm: { ...s.exportForm, formats } })),
  // ...
});
```

**Apply:** Phase 13 store should be a single `create()` (not `persist()` middleware — persistence is hand-rolled via plugin-store + per-project file). Use the recorder.ts flat-setter rhythm. Document this as the *second* slice-composed exception in `docs/CONVENTIONS.md` per the "Keep Agent Docs In Sync" rule (CLAUDE.md mandate).

---

### `lib/output-prefs-persist.ts` (migrator + subscribe effect)

**Primary analog:** `apps/desktop/src/lib/theme.ts` — module-level singleton with `getTheme()` / `setTheme()` / `applyPersistedTheme()` lifecycle (lines 14-39).
**Secondary analog:** `crates/storage/src/preset_io.rs` (lines 23, 99-140) — versioned schema with explicit migrator stub.

**Singleton lifecycle pattern** (from `theme.ts:14-39`):
```ts
export function getTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private mode); silently ignore.
  }
}

/** Call once on app mount to apply the persisted theme. */
export function applyPersistedTheme(): void {
  setTheme(getTheme());
}
```

**Versioned migrator pattern** (from `preset_io.rs:23, 110-115`):
```rust
pub const CURRENT_SCPRESET_VERSION: u32 = 2;
// ...
if file.version > CURRENT_SCPRESET_VERSION {
    return Err(err_too_new(file.version));
}
if file.version < CURRENT_SCPRESET_VERSION {
    file = migrate_preset_v1_to_v2(file)?;
}
```

**Apply:** Hand-roll a TS migrator chain `v0 (missing) -> v1 (seed Phase 12 defaults)`. Wrap `Store.load("output-prefs.v1")` in try/swallow per theme.ts pragma; on failure fall through to in-memory defaults. Per-project read failure → `sonner` toast (per UI-SPEC), not throw.

---

### `ipc/output-prefs.ts` (plugin-store TS wrapper)

**Analog:** `apps/desktop/src/ipc/encode.ts` (lines 1-78) — thin `invoke` wrappers with typed args + JSDoc.

**Imports + wrapper rhythm** (from `encode.ts:1-7, 64-78`):
```ts
/**
 * Encoder / recording IPC wrappers (Plan 01-08 commands). See
 * `apps/desktop/src-tauri/src/commands/encode.rs`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

export async function probeHwEncoders(): Promise<unknown> {
  return invoke("probe_hw_encoders");
}

export async function startRecording(
  args: StartRecordingArgs,
  onEvent: (e: RecordingEvent) => void,
): Promise<RecordingSessionId> {
  // ...
}
```

**Apply:** Module owns `loadOutputPrefs()`, `saveOutputPrefs()`, `loadProjectOverride(projectFolder)`, `saveProjectOverride(projectFolder, prefs)`. Plugin-store calls go through `import { Store } from '@tauri-apps/plugin-store'`; per-project file via `@tauri-apps/plugin-fs` (already installed — `package.json:5` per RESEARCH.md). Header docstring should cite "Phase 13's first production use of `tauri-plugin-store`".

---

### `components/ui/{accordion,toggle-group,radio-group,slider,input,label}.tsx` (shadcn Base UI primitives)

**Analog:** `apps/desktop/src/components/ui/select.tsx` (lines 1-80) — canonical shadcn-on-Base UI shape.

**Header doc + import rhythm** (from `select.tsx:1-19`):
```ts
/**
 * Select primitive — shadcn-style chrome on top of Base UI's Select.
 *
 * Follows the project's D-32 constraint: Base UI, not Radix. The exported
 * subcomponents mirror shadcn's naming (Trigger / Value / Content / Item)
 * so call sites read familiar.
 *
 * Enter/exit animations ride Base UI's `data-[starting-style]` +
 * `data-[ending-style]` attributes — same pattern as `dialog-motion.ts`.
 */

import * as React from "react";
import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;
```

**forwardRef + cn + token pattern** (from `select.tsx:21-47`):
```ts
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Trigger>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger
    ref={ref}
    className={cn(
      "inline-flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1.5 text-xs text-[var(--color-fg-primary)] transition-colors",
      "hover:bg-[var(--color-surface-300)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[popup-open]:bg-[var(--color-surface-300)]",
      className,
    )}
    {...props}
  >
    {children}
  </BaseSelect.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";
```

**Apply:** Scaffold via `pnpm dlx shadcn@latest add accordion toggle-group radio-group slider input label` (UI-SPEC line 100). Each generated file gets a 4-line header doc citing Phase 13. Token strings (`var(--color-...)`, `var(--radius-...)`) must come from `packages/ui/src/tokens.css` — never hardcoded hex.

---

### `features/recorder/video-output/video-output-section.tsx` (section container)

**Primary analog:** the `SettingsGroup` rhythm in `recording-view.tsx:793-835`.
**Secondary analog:** `AudioDevicePicker.tsx` (TanStack Query lazy load on `open`).

**Section composition pattern** (from `recording-view.tsx:793-808`):
```tsx
<SettingsGroup label="Microphone" icon={<SettingsIcon size={13} />}>
  <label
    htmlFor="audio-device-select"
    className="mb-1.5 block text-xs text-[var(--color-fg-muted)]"
  >
    Audio input
  </label>
  <AudioDevicePicker
    value={audioDeviceId}
    onValueChange={setAudioDeviceId}
    disabled={status === "recording" || status === "paused" || status === "stopping"}
  />
  <p className="mt-1.5 text-[10px] text-[var(--color-fg-muted)]">
    Default is off; choose "System default" to include voice-over. Resets every recording.
  </p>
</SettingsGroup>
```

**Disable-while-recording guard** (canonical, copy verbatim):
```ts
disabled={status === "recording" || status === "paused" || status === "stopping"}
```

**TanStack Query lazy-on-open pattern** (from `AudioDevicePicker.tsx:113-127`) — apply to HW encoder probe:
```ts
const [hasOpened, setHasOpened] = useState(false);
const { data: devices = [], isLoading } = useQuery<AudioInputInfo[]>({
  queryKey: ["audio-inputs"],
  queryFn: listAudioInputs,
  enabled: hasOpened,
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
});
```

**Apply:** Render as a new `<SettingsGroup>` slotted **after** `ChromeHidingToggle` (UI-SPEC layout). Use the same pre-record disable guard (D-13-01). HW encoder probe in `advanced-output-options.tsx` follows the lazy-on-open TanStack Query pattern with `queryKey: ["hw-encoders"]`.

---

### `preset-select.tsx`, `resolution-control.tsx` (Base UI Select bindings with discriminated unions)

**Analog:** `AudioDevicePicker.tsx` (lines 42-106) — `kind:payload` round-trip pattern for non-string union values.

**Discriminated-union round-trip pattern** (from `AudioDevicePicker.tsx:42-83`):
```ts
type AudioPickerChoice =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "device"; id: string }
  | { kind: "loading" }
  | { kind: "empty" };

function choiceToSelectValue(c: AudioPickerChoice): string {
  switch (c.kind) {
    case "none": return "none:";
    case "device": return `device:${c.id}`;
    // ...
  }
}

function selectValueToChoice(s: string): AudioPickerChoice {
  const idx = s.indexOf(":");
  const kind = idx === -1 ? s : s.slice(0, idx);
  const payload = idx === -1 ? "" : s.slice(idx + 1);
  // ...
}
```

**Apply directly** to `OutputResolution` (`P720`/`P1080`/`P1440`/`P4K`/`MatchSource`/`Custom{w,h}`) and `PadColor` (`Black`/`White`/`Custom{r,g,b}`). The `kind:payload` indirection isolates JSX from the DTO shape — exactly the same problem these enums pose.

---

### `fps-control.tsx`, `fit-mode-control.tsx`, `quality-preset-control.tsx` (segmented / radio groups)

**Analog:** `apps/desktop/src/features/post-production/export-modal/resolution-picker.tsx` (lines 24-54) and `format-checkboxes.tsx` (lines 23-69) — sr-only input + label-as-button pattern with active/inactive styling using accent token.

**Segmented label-as-button pattern** (from `resolution-picker.tsx:30-50`):
```tsx
<div className="grid grid-cols-3 gap-2">
  {OPTIONS.map((opt) => (
    <label
      key={opt.id}
      className={`flex cursor-pointer items-center justify-center rounded-2xl border px-3 py-3 text-sm font-medium transition ${
        value === opt.id
          ? "border-[var(--color-accent-primary)]/50 bg-[var(--color-accent-primary)]/10 text-[var(--color-fg-primary)] shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
          : "border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] text-[var(--color-fg-secondary)] hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-100)] hover:text-[var(--color-fg-primary)]"
      }`}
    >
      <input
        type="radio"
        name="export-resolution"
        value={opt.id}
        checked={value === opt.id}
        onChange={() => onChange(opt.id)}
        className="sr-only"
      />
      {opt.label}
    </label>
  ))}
</div>
```

**Apply:** UI-SPEC says scaffold `radio-group` and `toggle-group` Base UI primitives — but the existing project pattern is plain native + sr-only + label, which is more accessible and already in production for the export modal. Planner must reconcile: either (a) use Base UI primitives per UI-SPEC, OR (b) reuse the existing native pattern. Recommend (a) for a11y per UI-SPEC accessibility contract (arrow-key navigation, ARIA APG semantics).

---

### `pad-color-control.tsx` (segmented with color reveal)

**Primary analog:** `resolution-picker.tsx` (segmented base).
**Secondary:** `CursorToggle.tsx` (small bespoke control with label + hidden input).

**Custom reveal animation pattern** (from `recording-view.tsx:15` import + UI-SPEC motion table):
```ts
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
```
Use `motion.div` for the W/H + color/hex reveal — duration 160ms, ease `[0.22, 0.61, 0.36, 1]`, gate via `useReducedMotion()` (UI-SPEC line 230, recording-view.tsx already imports this).

**Apply:** Native `<input type="color">` per D-13-09; sync with `<input type="text">` for `#rrggbb`. Both wrapped in `<motion.div>` revealed when active segment === "Custom".

---

### `bitrate-preview.tsx`, `output-summary-badge.tsx` (presentational chips)

**Analog:** `recording-view.tsx` `LiveRecordingBadge` (line 856+) — small inline pill with token-based chrome.

**Pill chrome pattern** (from `recording-view.tsx:864-869`):
```tsx
<span
  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
    paused
      ? "bg-[var(--color-warning)]/15 text-[var(--color-warning)]"
      : "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
  }`}
>
```

**Apply:** Summary badge uses `h-8 px-3 rounded-full` per UI-SPEC line 49. Bitrate preview uses mono font + info-stripe left border per UI-SPEC typography table.

---

### `warnings.tsx` (a11y warning list)

**Analog:** `export-modal.tsx:67` (`warnings: string[]` state) + `TriangleAlert` icon import (line 26).

**Warning array + render pattern** (from `export-modal.tsx:67, 105-116`):
```ts
const [warnings, setWarnings] = useState<string[]>([]);
const runValidate = useCallback(async () => {
  const errs: string[] = [];
  for (const cfg of outputs) {
    try {
      await exportValidateConfig(cfg);
    } catch (err) {
      errs.push(`${cfg.format} @ ${cfg.resolution}/${cfg.fps}: ${String(err)}`);
    }
  }
  setWarnings(errs);
  return errs.length === 0;
}, [outputs]);
```

**Apply:** Two variants per UI-SPEC: `error` (hard-blocks submit, `aria-describedby` on offending input) and `warn` (`aria-live="polite"` polite live region). Use `TriangleAlert` from `lucide-react`. Compute purely from current knob state (no IPC).

---

### `advanced-output-options.tsx` (export modal Advanced disclosure)

**Primary analog:** `export-modal.tsx:244-335` — section rhythm with rounded `<section>` cards and uppercase tracking labels.

**Section card pattern** (from `export-modal.tsx:245-254`):
```tsx
<section className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
  <FormatCheckboxes value={form.formats} onChange={setFormats} />
</section>

<section className="rounded-[var(--radius-2xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
  <ResolutionPicker value={form.resolution} onChange={setResolution} />
</section>
```

**Uppercase label pattern** (from `export-modal.tsx:217-219`):
```tsx
<div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
  Formats
</div>
```

**Apply:** Render as a single Base UI `Accordion` (one item, collapsed by default) inserted after line 282 (the `Motion fidelity` `<section>`) and before the destination/folder section. Use the 3-subgroup grid per UI-SPEC layout.

---

### `ipc/encode.ts` (modify — thread 5 optional DTO fields)

**Self-analog:** lines 22-35 already show the optional-field rhythm.

**Optional field pattern** (from `encode.ts:22-35`):
```ts
/**
 * Phase 6 plan 01 — optional mic device. `null` / undefined = no
 * audio (silent track, Phase 1 behavior). [...]
 */
audio_device_id?: string | null;
/**
 * Plan 06-02 — per-recording include-cursor flag (D-19/D-20).
 * `undefined` / `null` → backend default (true). [...]
 */
include_cursor?: boolean | null;
```

**Apply:** Append 5 optional fields to `StartRecordingArgs` interface — `output_resolution?`, `fit_mode?`, `pad_color?`, `quality_preset?`, `scale_algo?` — each typed against the Phase 12 DTOs auto-emitted into `packages/shared-types/src/ipc.ts` by tauri-specta. Each field gets a 3-line JSDoc citing Phase 13 D-13-XX.

---

### `ipc/export.ts` (modify — extend `ExportOutput` with encoder options)

**Self-analog:** `export.ts:15-31` shows the `ExportOutput` shape.

**Apply:** Extend `ExportOutput` with optional `encoder_options?: ExportEncoderOptionsDto` sub-struct (RESEARCH.md "IPC surface — Export command extension" recommendation b). The Phase 12 `ExportOutputDto` registered at `ipc_spec.rs:201` may need a Rust-side extension — flag during planning whether the backend type already accepts the field via serde-default or needs an additive plan task. **Backend-touching: do not assume frontend-only.**

---

### `src-tauri/src/lib.rs` (modify — register tauri-plugin-store)

**Self-analog:** plugin chain at lines 102-114.

**Plugin chain pattern** (from `lib.rs:102-114`):
```rust
.plugin(tauri_plugin_log::Builder::default()
    .level(log::LevelFilter::Info)
    .max_file_size(50 * 1024 * 1024 /* 50 MiB */)
    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
    .build())
.plugin(tauri_plugin_fs::init())
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_updater::Builder::new().build())
```

**Apply:** Add `.plugin(tauri_plugin_store::Builder::default().build())` after `tauri_plugin_fs::init()`. Add `tauri-plugin-store = "2.4"` to `apps/desktop/src-tauri/Cargo.toml`. Add `@tauri-apps/plugin-store` to `apps/desktop/package.json`. Verify `apps/desktop/src-tauri/capabilities/default.json` permits store + fs scope for `$APPDATA/output-prefs.json` and `$PROJECT/.storycapture/**`.

---

## Shared Patterns

### Pre-record disable guard

**Source:** `recording-view.tsx:803, 824, 831` (verbatim repeated).
**Apply to:** Every interactive control inside `<VideoOutputSection>`.
```ts
disabled={status === "recording" || status === "paused" || status === "stopping"}
```

### Token-only styling (no hex)

**Source:** every component above; canonical `select.tsx:28-33`.
**Apply to:** All new components. Use `var(--color-*)`, `var(--radius-*)`, `var(--shadow-*)` exclusively. Tokens defined in `packages/ui/src/tokens.css`.

### Header docstring rhythm

**Source:** `select.tsx:1-10`, `AudioDevicePicker.tsx:1-6`, `CursorToggle.tsx:1-5`.
**Apply to:** Every new file. 3–5 line block comment citing the plan id + relevant decision (e.g. `D-13-XX`) and any non-obvious constraint (e.g. "first production use of plugin-store").

### IPC error handling

**Source:** `recording-view.tsx:67-83` (`formatIpcError`) + `export-modal.tsx:80-90` (`pickFolder` try/catch + `toast.error`).
**Apply to:** Persistence failures in `output-prefs-persist.ts` — silent fallthrough for read failures; `toast.error("Không lưu được tùy chọn vào dự án.")` for write failures (UI-SPEC line 305-306).

### Reduced-motion gating

**Source:** `recording-view.tsx:15` (`useReducedMotion` import), used throughout Phase 12 motion surfaces.
**Apply to:** Accordion expand, custom-reveal rows, summary-badge scroll, pad-color segmented active-indicator slide. Per UI-SPEC motion table.

### Vietnamese copy centralization

**Source:** No existing precedent — Phase 13 establishes the pattern.
**Apply to:** `features/recorder/video-output/copy.ts` and `features/post-production/export-modal/advanced-copy.ts`. All user-facing strings exported as named constants (e.g. `LABEL_RESOLUTION = "Độ phân giải"`); never inlined in JSX. Per CD-13-03 + UI-SPEC copywriting contract.

### Slice composition exception (must update docs)

**Source:** `docs/CONVENTIONS.md` documents post-production as the *only* exception today; `store.ts` is the implementation.
**Apply:** Phase 13 introduces the *second* exception (cross-feature `output-prefs.ts`). Per CLAUDE.md "Keep Agent Docs In Sync After Impactful Changes" mandate, the same plan that ships `state/output-prefs.ts` must also update `docs/CONVENTIONS.md` to list it.

---

## No Analog Found

| File | Role | Reason |
|------|------|--------|
| `lib/output-prefs-persist.ts` (full plugin-store usage) | persistence singleton | No prior production use of `@tauri-apps/plugin-store` in repo (only TODO refs in `theme.ts:5` and `editor/split-pane.tsx:4`). Theme uses localStorage; `app_settings.rs` deliberately avoids plugin-store. **Greenfield design — RESEARCH.md provides the pattern.** |
| Per-project `<project>/.storycapture/output.json` adapter | file-I/O | No prior `.storycapture` subfolder convention. `crates/storage/src/preset_io.rs` is the closest read/write+migrate analog but operates on `.scpreset` files registered in SQLite, not arbitrary per-project JSON. **Greenfield — model on `preset_io.rs`'s versioned read/write structure but use `@tauri-apps/plugin-fs` (TS) instead of `std::fs` (Rust).** |
| `features/recorder/video-output/copy.ts` (i18n constants) | static strings | No centralized Vietnamese copy module exists yet — Phase 13 is the first. Pattern is trivial (`export const X = "..."`); no analog needed. |

---

## Metadata

**Analog search scope:**
- `apps/desktop/src/features/recorder/`
- `apps/desktop/src/features/post-production/`
- `apps/desktop/src/components/ui/`
- `apps/desktop/src/state/`, `apps/desktop/src/lib/`, `apps/desktop/src/ipc/`
- `apps/desktop/src-tauri/src/{lib.rs,ipc_spec.rs,commands/}`
- `crates/storage/src/preset_io.rs`

**Files scanned:** ~30 (focused targeted reads — no whole-repo grep)
**Pattern extraction date:** 2026-04-19

---

## Planner Quick-Reference

| Plan area | Primary file pattern | Primary state pattern | Primary IPC pattern |
|-----------|----------------------|------------------------|---------------------|
| Wave 0 — primitives + plugin add | `select.tsx` (forwardRef + cn + tokens) | — | `lib.rs:102-114` plugin chain |
| Wave 1 — preset slice + persistence | `store.ts` (composition) + `recorder.ts` (setters) | `theme.ts` singleton + `preset_io.rs` versioned migrator | `encode.ts` thin invoke wrapper (for plugin-store calls) |
| Wave 2 — Recording UI | `AudioDevicePicker.tsx` (Select + lazy query) + `resolution-picker.tsx` (segmented) | `recorder.ts` setter rhythm | `encode.ts:22-35` optional field append |
| Wave 3 — Export UI + summary badge + warnings | `export-modal.tsx:244-335` section rhythm + `LiveRecordingBadge` pill | `export-slice.ts` setter rhythm | `export.ts:15-31` `ExportOutput` extension |

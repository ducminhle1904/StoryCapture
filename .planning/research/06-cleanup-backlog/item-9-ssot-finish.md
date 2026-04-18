# Backlog #9 — Browser-Preset SSOT Finish (Rust codegen + caller migration)

**Researched:** 2026-04-17 · **Confidence:** HIGH · **Effort:** ~1 day / single PR

## Current State

Landed:
- `packages/shared-types/browser-presets.json` — 11 presets, specific-first ordered.
- `packages/shared-types/src/browser-presets.ts` — exports `BROWSER_PRESETS`, `CHROMIUM_PRESET_IDS`, `titleHintForPreset`, `basenameFragmentsForPreset`, `isChromiumFamilyPreset`.
- Re-exported via `packages/shared-types/src/index.ts` (`export * from "./browser-presets"`).
- Desktop tsconfig paths resolve `@shared-types` → `packages/shared-types/src` (source-mapped — no build step).

Still hand-maintained (3 tables to eliminate):
1. `apps/desktop/src-tauri/src/title_hints.rs` — `PRESET_TOKENS` + `PATH_FRAGMENTS`.
2. `apps/desktop/src/features/recorder/title-hints.ts` — `BROWSER_TITLE_HINTS` + inline path heuristic.
3. `apps/desktop/src/features/settings/browser-presets.ts` — `CHROMIUM_PRESETS` set + inline `isChromiumFamily`.

## Build.rs Integration

Canonical Tauri v2 pattern: extend the existing `build.rs` — `tauri_build::build()` does not interfere with user codegen. Emit to `$OUT_DIR`, not src tree.

Add to `[build-dependencies]` in `apps/desktop/src-tauri/Cargo.toml`:
```toml
serde = { workspace = true }
serde_json = { workspace = true }
```

Extend `apps/desktop/src-tauri/build.rs`:
```rust
use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=src/ipc_spec.rs");
    println!("cargo:rerun-if-changed=src/commands/system.rs");
    println!("cargo:rerun-if-changed=src/error.rs");

    emit_browser_presets();
}

fn emit_browser_presets() {
    // CARGO_MANIFEST_DIR = apps/desktop/src-tauri → repo root is ../../..
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let json_path = manifest
        .join("../../../packages/shared-types/browser-presets.json")
        .canonicalize()
        .expect("browser-presets.json must exist");
    println!("cargo:rerun-if-changed={}", json_path.display());

    #[derive(serde::Deserialize)]
    struct File { presets: Vec<Preset> }
    #[derive(serde::Deserialize)]
    struct Preset { id: String, title: String, basenames: Vec<String> }

    let raw = fs::read_to_string(&json_path).expect("read browser-presets.json");
    let file: File = serde_json::from_str(&raw).expect("browser-presets.json is malformed");

    let mut out = String::from(
        "// @generated from packages/shared-types/browser-presets.json — do not edit.\n\
         pub struct PresetEntry {\n\
         \x20   pub id: &'static str,\n\
         \x20   pub title: &'static str,\n\
         \x20   pub basenames: &'static [&'static str],\n\
         }\n\n\
         pub static BROWSER_PRESETS: &[PresetEntry] = &[\n",
    );
    for p in &file.presets {
        out.push_str(&format!(
            "    PresetEntry {{ id: {:?}, title: {:?}, basenames: &[",
            p.id, p.title
        ));
        for b in &p.basenames {
            out.push_str(&format!("{:?}, ", b.to_lowercase()));
        }
        out.push_str("] },\n");
    }
    out.push_str("];\n");

    let dest = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("browser_presets.rs");
    fs::write(&dest, out).expect("write browser_presets.rs");
}
```

Notes: relative path from `apps/desktop/src-tauri/` to repo root is `../../..` (not `../../../../`). `canonicalize()` fails loudly if JSON moves. `{:?}` on `&str` emits a valid Rust string literal.

## Generated Module Shape

Consumed from `title_hints.rs`:
```rust
include!(concat!(env!("OUT_DIR"), "/browser_presets.rs"));
// Now in scope: `PresetEntry`, `BROWSER_PRESETS`.
```

`include!` at module scope is fine — no `pub use` collisions. Keep `PresetEntry` module-private (drop `pub` if preferred — `static BROWSER_PRESETS` needs `pub(crate)` only if cross-module).

## Migration Steps (ordered)

1. **build.rs extension** + Cargo `[build-dependencies]`. Run `cargo build -p storycapture` — confirm `$OUT_DIR/browser_presets.rs` emits.
2. **Rewrite `title_hints.rs`** — delete `PRESET_TOKENS` and `PATH_FRAGMENTS`. New impl:
   ```rust
   include!(concat!(env!("OUT_DIR"), "/browser_presets.rs"));

   pub fn title_hint_for(preset: Option<&str>) -> Option<String> {
       let input = preset?.trim();
       if input.is_empty() { return None; }
       let lower = input.to_lowercase();
       if let Some(p) = BROWSER_PRESETS.iter().find(|p| p.id == lower) {
           return Some(p.title.to_string());
       }
       let basename = lower.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("");
       if basename.is_empty() { return None; }
       // JSON order is specific-first, so first basename-contains match wins.
       for p in BROWSER_PRESETS {
           if p.basenames.iter().any(|b| basename.contains(b)) {
               return Some(p.title.to_string());
           }
       }
       None
   }
   ```
   Public API (`title_hint_for`, `redact_title_hint`) unchanged → `commands/capture.rs` untouched. All existing tests pass without edits.
3. **Migrate `features/recorder/title-hints.ts`** — convert to thin adapter re-exporting from shared-types. Preserve named exports (`BROWSER_TITLE_HINTS`, `titleHintFor`, `redactTitleHint`) so the test file doesn't need to change:
   ```ts
   import { BROWSER_PRESETS, titleHintForPreset, basenameFragmentsForPreset }
     from "@storycapture/shared-types";

   export const BROWSER_TITLE_HINTS: Readonly<Record<string, string>> =
     Object.fromEntries(BROWSER_PRESETS.map(p => [p.id, p.title]));

   export function titleHintFor(preset: string | null | undefined): string | undefined {
       if (!preset) return undefined;
       const lower = preset.toLowerCase();
       const direct = titleHintForPreset(lower);
       if (direct) return direct;
       const basename = lower.split(/[\/\\]/).pop() ?? "";
       if (!basename) return undefined;
       for (const p of BROWSER_PRESETS) {
           if (p.basenames.some(b => basename.includes(b))) return p.title;
       }
       return undefined;
   }

   export function redactTitleHint(h: string | undefined | null): string {
       if (!h) return "<none>";
       return h.length > 40 ? `${h.slice(0, 40)}…` : h;
   }
   ```
4. **Migrate `features/settings/browser-presets.ts`** — replace hand set with shared-types:
   ```ts
   import { BROWSER_PRESETS, CHROMIUM_PRESET_IDS } from "@storycapture/shared-types";
   export const CHROMIUM_PRESETS = CHROMIUM_PRESET_IDS; // back-compat re-export
   export function isChromiumFamily(label: string | null | undefined): boolean {
       if (!label) return true;
       const lower = label.toLowerCase();
       if (CHROMIUM_PRESET_IDS.has(lower)) return true;
       const basename = lower.split(/[\/\\]/).pop() ?? "";
       return BROWSER_PRESETS.some(p => p.basenames.some(b => basename.includes(b)));
   }
   ```
   `ChromeHidingToggle.tsx` imports `isChromiumFamily` — unchanged.
5. **Verify with grep** that no file references the old tables outside their own definitions, then run full test suite.

## Test Plan

- `cargo test -p storycapture title_hints` — 11 existing tests, all should pass unchanged.
- `pnpm --filter desktop test title-hints` — existing vitest suite untouched.
- **New regression test** (Rust + TS): assert `BROWSER_PRESETS.len() == 11` and ids match a hardcoded list — catches accidental JSON deletions.
- Manual: `pnpm tauri dev` → pick Chrome Canary preset → confirm recording auto-follow still resolves the Canary window (not generic Chrome).

## Risks

- **Build-order for TS**: shared-types is source-mapped via tsconfig paths + Vite — no prebuild needed. JSON imports already work (landed in current `browser-presets.ts`). LOW risk.
- **Relative path in build.rs**: if repo layout changes, `canonicalize()` panics at build time with a clear message. LOW risk.
- **Specific-first iteration**: JSON `_comment` documents the invariant. Rust and TS heuristics both iterate `BROWSER_PRESETS` directly, inheriting order. Add a smoke test asserting `chrome-canary` appears before `chrome` in the array. LOW risk.
- **`msedge` basename conflict**: basenames in JSON are `"microsoft edge"` (with space) — distinct from `"chrome"` — no overlap. Verified against current `PATH_FRAGMENTS`.
- **Effort**: +~45 LOC build.rs, −~40 LOC hand tables (Rust), −~15 LOC TS deduplication. Net slightly positive LOC, but three sources of truth collapse to one.

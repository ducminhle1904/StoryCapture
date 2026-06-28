# Bundled effect presets

Five default `.scpreset` JSON files shipped with StoryCapture. Each file has a
stable UUID so installation can be idempotent across app restarts.

| File               | Name              | Auto-zoom       | Max zoom | Dwell  | Background           | Cursor ripple | BGM                |
|--------------------|-------------------|-----------------|----------|--------|----------------------|---------------|--------------------|
| `linear.scpreset`  | Linear            | subtle pan-only | 1.0x     | 1200ms | Solid white          | —             | —                  |
| `runway.scpreset`  | Runway Cinematic  | dynamic         | 3.0x     | 500ms  | Gradient runway-dark | white α≈0.95, max_r 80px | — |
| `tella.scpreset`   | Tella             | calm            | 2.2x     | 800ms  | Gradient tella-warm  | —             | default.mp3 @ −14 dB |
| `loom.scpreset`    | Loom              | subtle          | 1.4x     | 1000ms | Solid #f8f9fb        | —             | loom-ambient.mp3 @ −18 dB + subtle click SFX |
| `plain.scpreset`   | Plain             | —               | 1.0x     | —      | —                    | —             | —                  |

## Installation

On first app launch, the Electron host can install these files into a project
preset store. Because each file embeds a stable `id`, subsequent installs can
be no-ops even if the user has edited the bundled row.

## Adding a new bundled preset

1. Pick a fresh UUID v7 (`uuidgen`) and bake it into the new `.scpreset` file
   as the top-level `id`.
2. Drop the file in this directory.
3. Add a row to the table above.
4. No code changes needed — `install_bundled` picks up every `*.scpreset`
   file it finds here.

## Why JSON, not Rust constants?

Users inspect and tweak presets through the same UI they use for their own
custom presets. Shipping defaults as data (not as hard-coded Rust structs)
means the preset picker renders them identically and export/import works
out of the box — the bundled presets round-trip through `export_preset` and
`import_preset` without any special casing.

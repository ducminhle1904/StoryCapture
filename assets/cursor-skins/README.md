# Cursor Skins

Bundled cursor skin assets consumed by the cursor overlay engine.

## Skins

| File                | Intended use                                          |
|---------------------|-------------------------------------------------------|
| `mac-default.png`   | macOS recordings — black fill + white outline        |
| `win-default.png`   | Windows recordings — dark-grey fill + light outline  |
| `dark.png`          | Dark-theme presentations — pure black on mid-grey    |
| `light.png`         | Light-theme presentations — white on near-black      |
| `big-arrow.png`     | Presentation mode — 2× scaled arrow for demos        |

## Origin

The PNGs are committed so runtime builds do not depend on an asset generation
step.

Each skin is a 64 × 64 (or 128 × 128 for `big-arrow`) transparent PNG. The
cursor hotspot is the top-left corner; the compositor anchors skins at
`sample.pos` directly.

Users can select between these skins and optionally apply a `size_scale` /
`color_tint`; current post-production behavior is documented in
`docs/DOMAIN.md`. **Custom user-supplied skins are out of scope for the current
asset set** and remain deferred unless product scope changes.

## Licence

Internal project asset. Permissive reuse within StoryCapture; not separately
published.

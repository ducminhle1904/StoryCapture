# Gradient Presets

10 curated 1920×1080 background presets (POST-04, D-23) rendered to PNG and
committed to the repo.

Regenerate deterministically:

```bash
cargo run -p effects --example gen_gradient_presets
```

The generator is pure (no randomness) — re-running produces byte-identical
PNGs except for `paper-grain` which uses a fixed-seed PRNG.

## Preset list

| id                  | palette                              | use                 |
| ------------------- | ------------------------------------ | ------------------- |
| `runway-dark`       | near-black → violet, diagonal        | cinematic / hero    |
| `runway-light`      | off-white → warm-white, vertical     | editorial / print   |
| `linear-slate`      | dark-slate, vertical                 | editor / minimal    |
| `elevenlabs-violet` | deep-purple → violet, diagonal       | timeline / audio    |
| `warm-sunset`       | orange → magenta, diagonal           | demo / warm         |
| `cool-ocean`        | navy → teal, vertical                | product / tech      |
| `forest-emerald`    | forest green, vertical               | eco / outdoor       |
| `solid-black`       | solid #000                           | full-frame focus    |
| `solid-white`       | solid #fff                           | print / light       |
| `paper-grain`       | paper + deterministic speckle noise  | documentary feel    |

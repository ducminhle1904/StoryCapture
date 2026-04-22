
## Discovered during 17-06 execution (pre-existing, out of scope)

- `crates/capture/src/target.rs:48,77,95` — clippy::uninlined_format_args (3 sites). Pre-existing on main.
- `crates/capture/src/macos/screenshot.rs:136` — unused import `crate::display::DisplayId`.
- `crates/capture/src/macos/sck_backend.rs:618` — `build_filter_for_test_region` dead_code.
- `crates/capture/src/fallback/xcap_backend.rs` — clippy::type_complexity.

Verified with `git stash && cargo clippy` — all present on main before 17-06.

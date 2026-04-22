// Shared `real-ffmpeg`-gated helpers: host triple + ffmpeg/ffprobe path
// resolution. Loaded into each test binary via `include!`, matching the
// pattern used for `synthetic.rs`.

#[allow(dead_code)]
fn host_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

#[allow(dead_code)]
fn ws_root() -> Option<std::path::PathBuf> {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

#[allow(dead_code)]
fn bundled_bin_path(name: &str) -> Option<std::path::PathBuf> {
    let triple = host_triple();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let p = ws_root()?
        .join("scripts/build-ffmpeg/out")
        .join(format!("{name}-{triple}{ext}"));
    p.exists().then_some(p)
}

#[allow(dead_code)]
fn ffmpeg_path() -> Option<std::path::PathBuf> {
    bundled_bin_path("ffmpeg")
}

#[allow(dead_code)]
fn ffprobe_path() -> Option<std::path::PathBuf> {
    bundled_bin_path("ffprobe")
}

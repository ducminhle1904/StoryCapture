//! Non-silent RMS gate for the bundled sound library (Plan 02-08 Task 2).
//!
//! Shells out to `ffmpeg` with `astats=metadata=1:reset=1 -f null -` for each
//! SFX/BGM file and asserts the per-file `Overall.RMS_level` is above -60 dB.
//! This is the belt-and-braces check that no placeholder (silent) audio can
//! ship: even a human listen-test could theoretically approve a file that the
//! CI runner happens to skip, but this test will catch any file whose RMS
//! level falls below the audibility floor.
//!
//! `#[ignore]`-gated so `cargo test -p effects` remains green on developer
//! laptops that haven't installed ffmpeg; CI overrides with `cargo test -- --include-ignored`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const RMS_FLOOR_DB: f64 = -60.0;

fn sound_root() -> PathBuf {
    PathBuf::from("../../assets/sound-library")
}

/// Returns the `Overall.RMS_level` reported by `ffmpeg -af astats`, in dB.
fn measure_rms_db(file: &Path) -> Result<f64, String> {
    let output = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(file)
        .args(["-af", "astats=metadata=1:reset=1", "-f", "null", "-"])
        .output()
        .map_err(|e| format!("spawn ffmpeg: {}", e))?;

    // astats writes to stderr.
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        // Prefer "Overall" RMS if present (summary line), else first per-channel.
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("RMS level dB:") {
            let v = rest.trim().parse::<f64>().map_err(|e| e.to_string())?;
            return Ok(v);
        }
    }
    Err(format!(
        "no 'RMS level dB:' line in ffmpeg output for {}",
        file.display()
    ))
}

#[test]
#[ignore = "requires ffmpeg on PATH + curated audio files (blocking gate)"]
fn every_bundled_audio_file_is_non_silent() {
    let mut failures: Vec<String> = Vec::new();
    for sub in ["sfx", "bgm"] {
        let dir = sound_root().join(sub);
        let Ok(entries) = fs::read_dir(&dir) else {
            failures.push(format!("directory missing: {}", dir.display()));
            continue;
        };
        for entry in entries {
            let entry = entry.unwrap();
            if !entry.metadata().unwrap().is_file() {
                continue;
            }
            let path = entry.path();
            match measure_rms_db(&path) {
                Ok(db) => {
                    if !(db > RMS_FLOOR_DB) {
                        failures.push(format!(
                            "{} is silent or nearly silent: RMS {:.1} dB",
                            path.display(),
                            db
                        ));
                    }
                }
                Err(e) => failures.push(format!("{}: {}", path.display(), e)),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "RMS gate failures:\n  {}",
        failures.join("\n  ")
    );
}

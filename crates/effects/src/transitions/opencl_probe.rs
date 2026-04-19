//! Runtime probe for `xfade_opencl` filter availability.
//!
//! Spawns `ffmpeg -hide_banner -filters` and scans stdout for the substring
//! `xfade_opencl`. Parsed as a pure function (`probe_from_stdout`) for
//! hermetic tests; `probe_xfade_opencl` is the process-spawning wrapper.

use std::path::Path;
use std::process::Command;

use crate::error::EffectsError;

/// Availability report returned by [`probe_xfade_opencl`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenClAvailability {
    /// True iff ffmpeg reports an `xfade_opencl` filter.
    pub xfade_opencl: bool,
    /// First line of the ffmpeg banner, e.g. `"ffmpeg version 7.1 ..."`.
    /// Empty string when we couldn't parse a version.
    pub ffmpeg_version: String,
}

/// Parse `ffmpeg -filters` stdout; pure function for unit tests.
pub fn probe_from_stdout(stdout: &str) -> OpenClAvailability {
    let xfade_opencl = stdout.contains("xfade_opencl");
    // `-hide_banner` suppresses the version line; callers can separately run
    // `ffmpeg -version` if they want it. Try to recover a version if the
    // caller didn't hide the banner.
    let ffmpeg_version = stdout
        .lines()
        .find(|l| l.starts_with("ffmpeg version"))
        .unwrap_or("")
        .to_string();
    OpenClAvailability {
        xfade_opencl,
        ffmpeg_version,
    }
}

/// Run `ffmpeg -hide_banner -filters`, then also `ffmpeg -version` for the
/// banner, and report availability of `xfade_opencl`.
pub fn probe_xfade_opencl(ffmpeg_path: &Path) -> Result<OpenClAvailability, EffectsError> {
    let filters = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-filters")
        .output()
        .map_err(|e| EffectsError::FfmpegProbe(format!("spawn ffmpeg -filters: {e}")))?;
    let stdout = String::from_utf8_lossy(&filters.stdout);
    let mut out = probe_from_stdout(&stdout);

    // Best-effort version lookup.
    if out.ffmpeg_version.is_empty() {
        if let Ok(v) = Command::new(ffmpeg_path).arg("-version").output() {
            if let Some(line) = String::from_utf8_lossy(&v.stdout).lines().next() {
                out.ffmpeg_version = line.to_string();
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WITH_OPENCL: &str = "\
Filters:
 V->V       xfade           Cross fade one video with another video.
 V->V       xfade_opencl    Cross fade one video with another video (OpenCL).
 V->V       zoompan         Apply Zoom & Pan effect.
";

    const WITHOUT_OPENCL: &str = "\
Filters:
 V->V       xfade           Cross fade one video with another video.
 V->V       zoompan         Apply Zoom & Pan effect.
";

    #[test]
    fn opencl_probe_detects_filter() {
        let out = probe_from_stdout(WITH_OPENCL);
        assert!(out.xfade_opencl);
    }

    #[test]
    fn opencl_probe_absent() {
        let out = probe_from_stdout(WITHOUT_OPENCL);
        assert!(!out.xfade_opencl);
    }

    #[test]
    fn parses_version_when_banner_present() {
        let s = "ffmpeg version 7.1 Copyright (c) 2000-2024\n ...\n";
        let out = probe_from_stdout(s);
        assert!(out.ffmpeg_version.starts_with("ffmpeg version 7.1"));
    }
}

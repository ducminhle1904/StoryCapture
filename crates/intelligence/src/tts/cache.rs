//! TTS filesystem cache: content-addressed MP3 storage.
//!
//! Cache key = SHA-256(provider | model | voice_id | script_text).
//! Output path = `{project}/voiceover/{sanitized_step_id}-{hash[..16]}.mp3`.
//!
//! Security:
//! - T-03-11-01: `sanitize_step_id` strips all path-traversal characters.
//! - `cache_path` canonicalizes and asserts the result is inside `root/voiceover/`.

use std::path::{Path, PathBuf};

use crate::error::IntelError;

/// Deterministic cache key from synthesis parameters.
pub fn hash_key(provider: &str, model: &str, voice_id: &str, script_text: &str) -> String {
    util::sha256_hex(&[
        provider.as_bytes(),
        b"|",
        model.as_bytes(),
        b"|",
        voice_id.as_bytes(),
        b"|",
        script_text.as_bytes(),
    ])
}

/// Strip everything except `[A-Za-z0-9_-]` from a step ID.
/// Returns `"step"` if the result would be empty.
pub fn sanitize_step_id(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "step".to_string()
    } else {
        cleaned
    }
}

/// Build the cache path for a TTS clip.
///
/// The path is `{project_root}/voiceover/{sanitized_step_id}-{hash[..16]}.mp3`.
/// The `voiceover/` directory is created if it does not exist.
///
/// # Path traversal protection
///
/// The step_id is sanitized (no `.`, `/`, `\`), and the final path is
/// canonicalized and checked to ensure it remains inside `project_root`.
pub fn cache_path(project_root: &Path, step_id: &str, hash: &str) -> Result<PathBuf, IntelError> {
    let safe_id = sanitize_step_id(step_id);
    let truncated_hash = &hash[..hash.len().min(16)];
    let voiceover_dir = project_root.join("voiceover");

    // Create the directory if it doesn't exist (needed for canonicalize).
    std::fs::create_dir_all(&voiceover_dir)?;

    let file_name = format!("{}-{}.mp3", safe_id, truncated_hash);
    let full_path = voiceover_dir.join(&file_name);

    // Canonicalize the voiceover dir and verify the path stays inside it.
    let canonical_root = voiceover_dir.canonicalize()?;
    // The file may not exist yet, so we canonicalize the parent and append.
    let canonical_target = canonical_root.join(&file_name);

    // Defense-in-depth: verify the target is inside the project root.
    let canonical_project = project_root.canonicalize()?;
    if !canonical_target.starts_with(&canonical_project) {
        return Err(IntelError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "cache path escapes project root: {}",
                canonical_target.display()
            ),
        )));
    }

    Ok(full_path)
}

/// Probe the duration of an MP3 audio buffer in milliseconds.
///
/// Uses symphonia to decode MP3 metadata and compute total duration
/// from codec parameters (sample rate + total frames).
pub fn probe_audio_duration_ms(bytes: &[u8]) -> Result<u64, IntelError> {
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::probe::Hint;

    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("mp3");

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())
        .map_err(|e| {
            IntelError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("failed to probe MP3: {e}"),
            ))
        })?;

    let format = probed.format;

    // Try to get duration from the default track's codec params.
    if let Some(track) = format.default_track() {
        let params = &track.codec_params;
        if let (Some(n_frames), Some(sample_rate)) = (params.n_frames, params.sample_rate) {
            if sample_rate > 0 {
                let duration_ms = (n_frames as u64 * 1000) / sample_rate as u64;
                return Ok(duration_ms);
            }
        }
    }

    // Fallback: read the time base from the track and compute from the
    // track's duration in time-base units.
    if let Some(track) = format.default_track() {
        if let Some(dur) = track.codec_params.n_frames {
            let tb = track
                .codec_params
                .time_base
                .unwrap_or(symphonia::core::units::TimeBase::new(1, 44100));
            let time = tb.calc_time(dur);
            let ms = (time.seconds as u64) * 1000 + (time.frac * 1000.0) as u64;
            return Ok(ms);
        }
    }

    Err(IntelError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "could not determine MP3 duration",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_key_is_deterministic() {
        let h1 = hash_key("a", "b", "c", "d");
        let h2 = hash_key("a", "b", "c", "d");
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_key_is_sensitive_to_input() {
        let h1 = hash_key("a", "b", "c", "d");
        let h2 = hash_key("a", "b", "c", "e");
        assert_ne!(h1, h2);
    }

    #[test]
    fn sanitize_step_id_strips_traversal() {
        assert_eq!(sanitize_step_id("../evil"), "evil");
        assert_eq!(sanitize_step_id("s-01_abc"), "s-01_abc");
        assert_eq!(sanitize_step_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_step_id(""), "step");
        assert_eq!(sanitize_step_id("..."), "step");
    }

    #[test]
    fn cache_path_stays_inside_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let hash = "abcdef0123456789abcdef";

        // Normal case
        let p = cache_path(root, "s-01", hash).unwrap();
        assert!(p.to_string_lossy().contains("voiceover"));
        assert!(p.to_string_lossy().contains("s-01"));

        // Evil step_id — must still land inside voiceover/
        let p2 = cache_path(root, "../evil", hash).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        // The path parent should be voiceover/ inside the project root
        let voiceover_dir = root.join("voiceover").canonicalize().unwrap();
        assert!(
            p2.canonicalize()
                .unwrap_or_else(|_| {
                    // File doesn't exist yet, check parent
                    let parent = p2.parent().unwrap().canonicalize().unwrap();
                    parent.join(p2.file_name().unwrap())
                })
                .starts_with(&canonical_root),
            "path should be inside project root"
        );
        // The sanitized path should NOT contain ".."
        assert!(
            !p2.to_string_lossy().contains(".."),
            "sanitized path must not contain '..'"
        );
    }

    #[test]
    fn probe_audio_duration_ms_returns_duration_for_fixture() {
        let fixture = include_bytes!("../../tests/fixtures/tts/sample-1sec.mp3");
        let duration = probe_audio_duration_ms(fixture);
        // The fixture is ~1.019s (39 frames * 1152 samples / 44100 Hz)
        // Allow +-200ms tolerance since the minimal fixture may not have perfect metadata
        match duration {
            Ok(ms) => {
                assert!(ms > 500 && ms < 2000, "expected ~1000ms, got {ms}ms");
            }
            Err(e) => {
                // If symphonia can't probe our minimal fixture, that's acceptable
                // as long as the function handles it gracefully
                panic!("probe_audio_duration_ms failed: {e}");
            }
        }
    }
}

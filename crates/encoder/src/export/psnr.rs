//! PSNR regression harness (POST-08). Task 3 wires the real ffmpeg spawn;
//! this module owns the stderr parser (which IS unit-testable without any
//! sidecar) and the public [`compute_psnr`] entrypoint used by the
//! integration test.

use std::path::Path;

use super::error::ExportError;

/// Result of an ffmpeg `psnr` filter run. Values are in decibels; higher
/// is closer to identical. `average = inf` for pixel-identical inputs
/// (FFmpeg prints `inf` which we clamp to `f64::INFINITY`).
#[derive(Debug, Clone, PartialEq)]
pub struct PsnrResult {
    pub average: f64,
    pub min: f64,
    pub max: f64,
}

/// Compare two video files pixel-by-pixel via the FFmpeg `psnr` filter.
///
/// ```bash
/// ffmpeg -i candidate -i reference -lavfi "[0:v][1:v]psnr=stats_file=-" -f null -
/// ```
///
/// Returns the parsed summary line from stderr. FFmpeg's last "Parsed_psnr_"
/// line reads like:
/// `PSNR y:40.28 u:44.21 v:44.29 average:41.71 min:32.14 max:49.88`
pub async fn compute_psnr(
    ffmpeg_path: &Path,
    reference: &Path,
    candidate: &Path,
) -> Result<PsnrResult, ExportError> {
    if !ffmpeg_path.exists() {
        return Err(ExportError::FfmpegMissing(ffmpeg_path.to_path_buf()));
    }
    let out = tokio::process::Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-i")
        .arg(candidate)
        .arg("-i")
        .arg(reference)
        .arg("-lavfi")
        .arg("[0:v][1:v]psnr=stats_file=-")
        .arg("-f")
        .arg("null")
        .arg("-")
        .output()
        .await
        .map_err(|e| ExportError::Io(format!("spawn ffmpeg psnr: {e}")))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_psnr_stats(&stderr)
}

/// Parse the final `average:NN.NN ... min:MM.MM ... max:MM.MM` line from
/// ffmpeg's stderr. Exposed for unit testing.
pub fn parse_psnr_stats(stderr: &str) -> Result<PsnrResult, ExportError> {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.contains("average:") && l.contains("min:") && l.contains("max:"))
        .ok_or(ExportError::PsnrParse)?;
    let avg = extract_num(line, "average:")?;
    let min = extract_num(line, "min:")?;
    let max = extract_num(line, "max:")?;
    Ok(PsnrResult {
        average: avg,
        min,
        max,
    })
}

fn extract_num(line: &str, key: &str) -> Result<f64, ExportError> {
    let idx = line.find(key).ok_or(ExportError::PsnrParse)?;
    let rest = &line[idx + key.len()..];
    // Take the leading numeric/`inf` token.
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let tok = rest[..end].trim_end_matches(|c: char| c == ',' || c == ';');
    if tok.eq_ignore_ascii_case("inf") {
        return Ok(f64::INFINITY);
    }
    tok.parse::<f64>().map_err(|_| ExportError::PsnrParse)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_STDERR: &str = r#"
Input #0, mp4, from 'a.mp4':
  Stream #0:0(und): Video: h264
[Parsed_psnr_0 @ 0x7f] PSNR y:40.28 u:44.21 v:44.29 average:41.71 min:32.14 max:49.88
"#;

    #[test]
    fn parse_psnr_happy() {
        let r = parse_psnr_stats(SAMPLE_STDERR).unwrap();
        assert!((r.average - 41.71).abs() < 1e-6);
        assert!((r.min - 32.14).abs() < 1e-6);
        assert!((r.max - 49.88).abs() < 1e-6);
    }

    #[test]
    fn parse_psnr_inf() {
        let s = "PSNR y:inf u:inf v:inf average:inf min:inf max:inf";
        let r = parse_psnr_stats(s).unwrap();
        assert!(r.average.is_infinite());
        assert!(r.min.is_infinite());
        assert!(r.max.is_infinite());
    }

    #[test]
    fn parse_psnr_missing_line_errors() {
        assert!(parse_psnr_stats("no psnr line here").is_err());
    }
}

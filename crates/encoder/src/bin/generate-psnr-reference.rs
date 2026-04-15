//! `generate-psnr-reference` — POST-08 Phase A seeding binary.
//!
//! Renders the shared reference graph at 1080p30 H.264 CRF 18 to the path
//! given by `--output`. Run ONCE on a known-good build and commit the
//! resulting ~5-10 MB MP4 with a commit prefix of `[fixture]`:
//!
//!     cargo run -p encoder --bin generate-psnr-reference --release -- \
//!         --output crates/encoder/tests/fixtures/1min_reference_1080p30.mp4
//!
//! Every subsequent CI run then renders the same graph and compares via
//! `cargo test -p encoder --test psnr_regression`, which fails if average
//! PSNR drops below 38 dB (see `.planning/phases/02-cinematic-post-production-export/02-CONTEXT.md` D-29).

use std::path::PathBuf;
use std::process::ExitCode;

use encoder::export::reference_graph::build_reference_graph;

#[derive(Debug)]
struct Args {
    output: PathBuf,
    source: PathBuf,
    ffmpeg: Option<PathBuf>,
    duration_s: u32,
}

const USAGE: &str = "\
generate-psnr-reference — POST-08 Phase A seeding binary

OPTIONS:
  --output    <path>   Output MP4 path (required; must be committed with
                       commit-message prefix '[fixture]')
  --source    <path>   Input MP4 path. If absent, a synthetic
                       'testsrc2+sine' MP4 is generated via ffmpeg.
  --ffmpeg    <path>   FFmpeg binary (or $FFMPEG_BIN). Required.
  --duration  <sec>    Clip duration in seconds (default 60)
  -h, --help
";

fn parse_args() -> Result<Args, String> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut output: Option<PathBuf> = None;
    let mut source: Option<PathBuf> = None;
    let mut ffmpeg: Option<PathBuf> = None;
    let mut duration_s: u32 = 60;
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--output" => {
                i += 1;
                output = Some(PathBuf::from(&raw[i]));
            }
            "--source" => {
                i += 1;
                source = Some(PathBuf::from(&raw[i]));
            }
            "--ffmpeg" => {
                i += 1;
                ffmpeg = Some(PathBuf::from(&raw[i]));
            }
            "--duration" => {
                i += 1;
                duration_s = raw[i].parse().map_err(|e| format!("duration: {e}"))?;
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("unknown arg: {other}")),
        }
        i += 1;
    }
    let output = output.ok_or_else(|| "--output required".to_string())?;
    let source = source.unwrap_or_else(|| output.with_extension("source.mp4"));
    Ok(Args {
        output,
        source,
        ffmpeg: ffmpeg.or_else(|| std::env::var_os("FFMPEG_BIN").map(PathBuf::from)),
        duration_s,
    })
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let ffmpeg = match args.ffmpeg.as_deref() {
        Some(p) => p,
        None => {
            eprintln!("error: --ffmpeg required (or $FFMPEG_BIN)");
            return ExitCode::from(2);
        }
    };
    if !ffmpeg.exists() {
        eprintln!("error: ffmpeg not found at {}", ffmpeg.display());
        return ExitCode::from(2);
    }
    // Build the reference graph (hermetic: metadata only — we don't actually
    // need to invoke `effects::emit::FfmpegEmit::emit` here; the reference
    // fixture is the encoded MP4 we produce below).
    let _graph = build_reference_graph(&args.source, 1920, 1080, 30);

    // Step 1: ensure we have a source MP4 to encode. If missing, synthesise
    // one via testsrc2 + sine (1080p30, CRF 18).
    if !args.source.exists() {
        eprintln!("source missing — synthesising {}", args.source.display());
        let status = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc2=size=1920x1080:rate=30:duration={}", args.duration_s),
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "sine=frequency=440:sample_rate=48000:duration={}",
                    args.duration_s
                ),
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-movflags",
                "+faststart",
            ])
            .arg(&args.source)
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                eprintln!("synthesise failed: status {}", s);
                return ExitCode::from(1);
            }
            Err(e) => {
                eprintln!("synthesise spawn: {e}");
                return ExitCode::from(1);
            }
        }
    }

    // Step 2: copy/encode source -> reference fixture at 1080p30 CRF 18.
    // For the current reference graph (Source-only) this is a straight
    // re-encode. When downstream plans add zooms/overlays, expand the
    // filter_complex here via `effects::emit::FfmpegEmit::emit(&_graph)`.
    let status = std::process::Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-i",
        ])
        .arg(&args.source)
        .args([
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-r",
            "30",
            "-movflags",
            "+faststart",
        ])
        .arg(&args.output)
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("wrote {}", args.output.display());
            println!("next step: git add {} && git commit -m '[fixture](02-11): seed POST-08 PSNR reference 1080p30'", args.output.display());
            ExitCode::SUCCESS
        }
        Ok(s) => {
            eprintln!("ffmpeg exited non-zero: {}", s);
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("ffmpeg spawn: {e}");
            ExitCode::from(1)
        }
    }
}

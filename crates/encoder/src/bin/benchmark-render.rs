//! `benchmark-render` — EXPORT-06 runner used by
//! `scripts/benchmark/render-1min.sh` and the GitHub Actions benchmark
//! workflows (`.github/workflows/render-benchmark.yml`,
//! `release-benchmark.yml`).
//!
//! Loads a `BenchmarkFixture` JSON, constructs the reference Graph via
//! the shared builder, and (unless `--dry-run`) executes
//! `render_intermediate + fanout_encode` against the FFmpeg binary
//! resolved from `--ffmpeg` or `$FFMPEG_BIN`.
//!
//! Usage:
//!   cargo run -p encoder --bin benchmark-render -- \
//!       --fixture scripts/benchmark/fixtures/1min-reference.json \
//!       --out-dir /tmp/bench \
//!       --formats mp4,webm \
//!       [--dry-run] \
//!       [--ffmpeg /abs/path/to/ffmpeg]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use encoder::export::batch::{build_batch, BatchExportRequest};
use encoder::export::format::OutputFormat;
use encoder::export::quality::Quality;
use encoder::export::reference_graph::BenchmarkFixture;
use encoder::export::resolution::Resolution;

#[derive(Debug, Clone)]
struct Args {
    fixture: PathBuf,
    out_dir: PathBuf,
    formats: Vec<OutputFormat>,
    dry_run: bool,
    ffmpeg: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut fixture: Option<PathBuf> = None;
    let mut out_dir: Option<PathBuf> = None;
    let mut formats_csv: Option<String> = None;
    let mut dry_run = false;
    let mut ffmpeg: Option<PathBuf> = None;

    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--fixture" => {
                i += 1;
                fixture = Some(PathBuf::from(&raw[i]));
            }
            "--out-dir" => {
                i += 1;
                out_dir = Some(PathBuf::from(&raw[i]));
            }
            "--formats" => {
                i += 1;
                formats_csv = Some(raw[i].clone());
            }
            "--dry-run" => dry_run = true,
            "--ffmpeg" => {
                i += 1;
                ffmpeg = Some(PathBuf::from(&raw[i]));
            }
            "--help" | "-h" => {
                println!("{}", USAGE);
                std::process::exit(0);
            }
            other => return Err(format!("unknown arg: {other}")),
        }
        i += 1;
    }

    let fixture = fixture.ok_or_else(|| "--fixture required".to_string())?;
    let out_dir = out_dir.ok_or_else(|| "--out-dir required".to_string())?;
    let formats_csv = formats_csv.unwrap_or_else(|| "mp4".into());
    let formats: Vec<OutputFormat> = formats_csv
        .split(',')
        .map(|s| match s.trim().to_ascii_lowercase().as_str() {
            "mp4" => Ok(OutputFormat::Mp4),
            "webm" => Ok(OutputFormat::WebM),
            "gif" => Ok(OutputFormat::Gif),
            other => Err(format!("unknown format: {other}")),
        })
        .collect::<Result<_, _>>()?;
    Ok(Args {
        fixture,
        out_dir,
        formats,
        dry_run,
        ffmpeg: ffmpeg.or_else(|| std::env::var_os("FFMPEG_BIN").map(PathBuf::from)),
    })
}

const USAGE: &str = "\
benchmark-render — EXPORT-06 runner

OPTIONS:
  --fixture  <path>     Path to BenchmarkFixture JSON (required)
  --out-dir  <path>     Output directory for encoded files (required)
  --formats  <csv>      Comma-separated subset of mp4,webm,gif (default: mp4)
  --dry-run             Parse + build Graph + exit 0 (no FFmpeg spawn)
  --ffmpeg   <path>     FFmpeg binary path (or set $FFMPEG_BIN)
  -h, --help            Show this help
";

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if !args.fixture.exists() {
        eprintln!("error: fixture not found: {}", args.fixture.display());
        return ExitCode::from(2);
    }
    let fixture_json = match std::fs::read_to_string(&args.fixture) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: read fixture: {e}");
            return ExitCode::from(2);
        }
    };
    let fixture: BenchmarkFixture = match serde_json::from_str(&fixture_json) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("error: parse fixture: {e}");
            return ExitCode::from(2);
        }
    };
    let graph = fixture.build_graph();
    // Batch at 1080p60 Medium for all requested formats.
    let specs = match build_batch(&BatchExportRequest {
        outputs: args
            .formats
            .iter()
            .map(|f| (*f, Resolution::R1080p, fixture.fps, Quality::Med))
            .collect(),
        out_folder: args.out_dir.clone(),
        base_name: "bench".into(),
    }) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: build_batch: {e}");
            return ExitCode::from(2);
        }
    };
    println!(
        "benchmark-render: fixture={} source={} graph nodes=video:{} audio:{} outputs={}",
        args.fixture.display(),
        fixture.source_path.display(),
        graph.video.len(),
        graph.audio.len(),
        specs.len()
    );
    for s in &specs {
        println!("  -> {}", s.output_path.display());
    }
    if args.dry_run {
        println!("dry_run OK");
        return ExitCode::SUCCESS;
    }
    let ffmpeg = match args.ffmpeg.as_deref() {
        Some(p) => p,
        None => {
            eprintln!("error: --ffmpeg <path> required (or $FFMPEG_BIN) unless --dry-run");
            return ExitCode::from(2);
        }
    };
    match run_full(ffmpeg, &fixture, &specs, &args.out_dir) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("benchmark-render failed: {e}");
            ExitCode::from(1)
        }
    }
}

fn run_full(
    _ffmpeg: &Path,
    _fixture: &BenchmarkFixture,
    _specs: &[encoder::export::batch::OutputSpec],
    _out_dir: &Path,
) -> Result<(), String> {
    // Full render path requires a real FFmpeg sidecar; the CI benchmark
    // script (`scripts/benchmark/render-1min.sh`) drives ffmpeg directly
    // with the filter_complex emitted from the Graph today. Once the
    // FanoutJobExecutor is wired we can replace this body with
    // `render_intermediate + fanout_encode`.
    Err("non-dry-run path pending FanoutJobExecutor wiring (Plan 11)".into())
}

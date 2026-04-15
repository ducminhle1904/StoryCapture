//! BGM auto-ducking under voiceover via `sidechaincompress` (D-22).
//!
//! The default parameters exactly match D-22 / Research §6 Code Example 7:
//! `threshold=0.08 ratio=8 attack=80ms release=400ms` with a target duck of
//! `-12 dB`. These values produce a producer-grade duck (no abrupt level
//! jumps, ~80 ms to pull down, ~400 ms to restore).

use serde::{Deserialize, Serialize};

/// Parameters for the `sidechaincompress` filter used to duck BGM under the
/// voiceover slot.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DuckParams {
    /// Level at which the compressor starts reducing the BGM (0.0-1.0 linear).
    pub threshold: f32,
    /// Compression ratio — 8:1 means every 8 dB above threshold becomes 1 dB.
    pub ratio: f32,
    /// Time to pull the BGM down once voiceover starts (ms).
    pub attack_ms: u32,
    /// Time to restore BGM level after voiceover ends (ms).
    pub release_ms: u32,
    /// Target duck level for the BGM when voiceover is active (dB, negative).
    pub duck_db: f32,
}

/// Canonical default — matches D-22 exactly. Do not change without updating
/// the snapshot fixture and the plan's acceptance grep.
pub const DEFAULT_DUCK: DuckParams = DuckParams {
    threshold: 0.08,
    ratio: 8.0,
    attack_ms: 80,
    release_ms: 400,
    duck_db: -12.0,
};

/// Emit the `sidechaincompress` filter segment.
///
/// - `bgm_label` — labelled input carrying the BGM (e.g. `[bgm_scaled]`).
/// - `sidechain_label` — labelled input carrying the voiceover (e.g. `[vo]`).
/// - `out_label` — label for the ducked BGM output (e.g. `[bgm_ducked]`).
///
/// Produces a string like:
/// `[bgm_scaled][vo]sidechaincompress=threshold=0.08:ratio=8:attack=80:release=400[bgm_ducked]`
pub fn emit_ducking(
    params: &DuckParams,
    bgm_label: &str,
    sidechain_label: &str,
    out_label: &str,
) -> String {
    format!(
        "{bgm}{sc}sidechaincompress=threshold={t}:ratio={r}:attack={a}:release={rel}{out}",
        bgm = bgm_label,
        sc = sidechain_label,
        t = params.threshold,
        r = params.ratio,
        a = params.attack_ms,
        rel = params.release_ms,
        out = out_label,
    )
}

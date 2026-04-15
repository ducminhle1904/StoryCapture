//! Audio mixer (POST-06).
//!
//! Builds an FFmpeg `filter_complex` fragment for the final audio mix:
//! captured audio + BGM (optionally ducked under a voiceover slot) + per-step
//! click SFX + transition whooshes → `amix` → `alimiter`.
//!
//! The implementation is a direct encoding of Research §6 Code Example 7
//! (sidechaincompress for ducking; amix+alimiter for safety). Per-file volume
//! pre-scaling satisfies Pitfall #9 (avoid `amix` clipping).
//!
//! The modules in this directory are:
//!
//! - [`ducking`] — `sidechaincompress` graph segment + [`ducking::DEFAULT_DUCK`] (D-22).
//! - [`click_sfx`] — per-step click splicing via `adelay` + `amix`.
//! - [`bgm`]       — BGM level helper.
//! - [`library`]   — bundled sound-pack manifest loader.
//! - [`mixer`]     — top-level [`mixer::emit_audio_mix`] that wires everything.

pub mod bgm;
pub mod click_sfx;
pub mod ducking;
pub mod library;
pub mod mixer;

pub use bgm::{emit_bgm_chain, BgmParams};
pub use click_sfx::{click_gain, emit_click_sfx, ClickEvent, ClickSfxLevel, WhooshEvent};
pub use ducking::{emit_ducking, DuckParams, DEFAULT_DUCK};
pub use library::{load_manifest, SoundEntry, SoundManifest};
pub use mixer::{emit_audio_mix, AudioMixConfig, AudioMixOutput, ExtraInput, InputKind};

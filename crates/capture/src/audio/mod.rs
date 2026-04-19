//! Mic-only audio capture. Pipeline:
//! cpal callback → `ringbuf::HeapRb<f32>` → std::thread → named pipe →
//! FFmpeg (`-f f32le`).
//!
//! Load-bearing invariants:
//!   - cpal callback: push_slice only, no cross-thread sync (cpal#970
//!     silently deregisters WASAPI callbacks otherwise).
//!   - Drain thread is std::thread (blocking pipe writes — NOT tokio).
//!   - Start AFTER FFmpeg opens the fifo for read.
//!   - Lazy device enumeration — never touch cpal before the user opts
//!     into audio, or macOS pops the mic TCC prompt at launch (cpal#901).

pub mod config;
pub mod device;
pub mod error;
pub mod fifo;
pub mod stream;

pub use config::{negotiate_input, AudioStreamInfo, NegotiatedAudioInput};
pub use device::{list_inputs, AudioInputInfo};
pub use error::AudioError;
pub use fifo::{make_fifo, FifoHandle};
pub use stream::AudioCaptureStream;

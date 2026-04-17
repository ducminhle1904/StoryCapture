//! Audio capture for Phase 6 (mic only; D-01, D-03).
//!
//! Pipeline shape (see RESEARCH §Pattern 1):
//!
//! ```text
//!   cpal callback ──► ringbuf::HeapRb<f32> ──► std::thread ──► named pipe
//!                                                                  │
//!                                                                  ▼
//!                                              FFmpeg -f f32le -i <fifo>
//! ```
//!
//! Invariants enforced here (do NOT relax without re-reading cpal#970):
//!   - The cpal input callback performs a single `push_slice` into a
//!     lock-free `ringbuf::HeapRb` producer. No mpsc, no mutex, no async.
//!     On Windows WASAPI any cross-thread synchronization inside the
//!     callback deregisters it silently (cpal#970).
//!   - The drain thread is a plain `std::thread` because it performs
//!     blocking writes to a POSIX fifo / Windows named pipe. It does not
//!     belong on the tokio runtime.
//!   - `AudioCaptureStream::start` must be called AFTER FFmpeg has opened
//!     the fifo for read. POSIX fifo open-for-write blocks until a reader
//!     is present (RESEARCH Pitfall 8).
//!   - Device enumeration is lazy. We never call
//!     `cpal::default_host().default_input_device()` until the user has
//!     opted in to audio for this recording — otherwise macOS triggers
//!     the Microphone TCC prompt at app launch (cpal#901).

pub mod device;
pub mod error;
pub mod fifo;
pub mod stream;

pub use device::{list_inputs, AudioInputInfo};
pub use error::AudioError;
pub use fifo::{make_fifo, FifoHandle};
pub use stream::{AudioCaptureStream, AudioStreamInfo};

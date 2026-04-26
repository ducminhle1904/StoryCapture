//! Audio capture error taxonomy.
//!
//! Thin, self-contained error enum — the host (`apps/desktop/src-tauri`)
//! maps these into `AppError` at the IPC boundary. Parallels
//! `crate::error::CaptureError` but for the cpal/fifo path, which has
//! its own failure modes (no default input, fifo IO).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    /// cpal's host reports no default input device. Either the OS has no
    /// mic plugged in, or TCC denied access before we even got to
    /// enumerate. Surface to the UI as "no mic available".
    #[error("no default input device available")]
    NoDefaultInput,

    /// The requested device id was not present in the enumeration.
    /// Usually means the user unplugged a USB mic between listing and
    /// recording.
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),

    /// cpal::SampleFormat enum round-tripped to string to avoid pulling
    /// cpal types into downstream crates. v1 supports F32 only — any
    /// other format triggers this.
    #[error("unsupported sample format: {0}")]
    UnsupportedFormat(String),

    /// Named-pipe IO. Most commonly fires when the drain thread tries to
    /// open the fifo for write before FFmpeg has opened it for read (the
    /// open blocks; if we time out we bail with this).
    #[error("fifo io: {0}")]
    Fifo(String),

    /// Generic cpal failure — stream build, device default config,
    /// enumeration errors all land here with the cpal error stringified.
    #[error("cpal: {0}")]
    Cpal(String),
}

impl From<std::io::Error> for AudioError {
    fn from(e: std::io::Error) -> Self {
        AudioError::Fifo(e.to_string())
    }
}

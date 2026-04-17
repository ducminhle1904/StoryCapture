//! `AudioCaptureStream` — cpal input stream + lock-free ringbuf + drain
//! thread writing raw f32 samples to a named pipe for FFmpeg.
//!
//! ## Lifecycle
//!
//! ```text
//!   FFmpeg spawns and opens(fifo, O_RDONLY)  ◄── must happen FIRST
//!          │
//!          ▼
//!   AudioCaptureStream::start()
//!     ├─ device.build_input_stream(cfg, |data| prod.push_slice(data), err_cb)
//!     ├─ std::thread::spawn(drain_loop)  // opens fifo(O_WRONLY), pumps ringbuf
//!     └─ stream.play()
//! ```
//!
//! On `Drop`:
//!   1. `stop_flag.store(true)` — drain loop notices and exits.
//!   2. `_stream` drops → cpal pauses/releases the callback.
//!   3. `drain_thread.join()` — bounded wait; thread is idle on the
//!      ringbuf poll and exits within a few ms.
//!
//! ## cpal#970 rule
//!
//! The input callback MUST use ONLY `ringbuf::Producer::push_slice`.
//! Adding *any* cross-thread synchronization primitive (tokio mpsc,
//! std mpsc, mutex, condvar, channels, parking_lot) causes WASAPI on
//! Windows to silently stop firing callbacks after a few dispatches.
//! See the inline comment in the callback body.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

use super::error::AudioError;

#[derive(Debug, Clone, Copy)]
pub struct AudioStreamInfo {
    pub sample_rate: u32,
    pub channels: u16,
    /// Always F32 in v1 — i16 sources are converted in-callback.
    pub format: SampleFormat,
}

pub struct AudioCaptureStream {
    // Keep the cpal Stream alive; drops first in the normal Drop order
    // (fields drop in declaration order), then the stop flag + thread.
    _stream: Box<dyn StreamTrait + Send>,
    stop_flag: Arc<AtomicBool>,
    /// `Arc<AtomicBool>` exposed to the host so a non-fatal degradation
    /// (stream invalidated mid-recording) can be surfaced via a Tauri
    /// event without requiring the full stream ownership to cross
    /// threads. Flipped by the cpal err_cb.
    degraded: Arc<AtomicBool>,
    drain_thread: Option<std::thread::JoinHandle<()>>,
    info: AudioStreamInfo,
}

impl AudioCaptureStream {
    /// Start capture.
    ///
    /// **Precondition:** FFmpeg (or another reader) has already opened
    /// `fifo_path` for read. On POSIX the drain thread's
    /// `OpenOptions::write(true).open(fifo)` call would otherwise block
    /// forever (RESEARCH Pitfall 8).
    ///
    /// `device_id` is the cpal device name from `AudioInputInfo::id`, or
    /// `None` to pick the host default. `"default"` is treated as an
    /// alias for `None`.
    pub fn start(
        device_id: Option<&str>,
        fifo_path: PathBuf,
    ) -> Result<(Self, AudioStreamInfo), AudioError> {
        // Mock path for CI / unit tests.
        #[cfg(feature = "audio-mock")]
        {
            if device_id == Some("__mock__") || std::env::var_os("STORYCAPTURE_AUDIO_MOCK").is_some()
            {
                return mock::start_mock(fifo_path);
            }
        }

        let host = cpal::default_host();
        let device = match device_id {
            None | Some("") | Some("default") => host
                .default_input_device()
                .ok_or(AudioError::NoDefaultInput)?,
            Some(name) => {
                let mut found = None;
                for d in host
                    .input_devices()
                    .map_err(|e| AudioError::Cpal(e.to_string()))?
                {
                    if d.name().ok().as_deref() == Some(name) {
                        found = Some(d);
                        break;
                    }
                }
                found.ok_or_else(|| AudioError::DeviceNotFound(name.to_string()))?
            }
        };

        let default_cfg = device
            .default_input_config()
            .map_err(|e| AudioError::Cpal(format!("default_input_config: {e}")))?;
        let sample_format = default_cfg.sample_format();
        let cfg: StreamConfig = default_cfg.clone().into();
        let sample_rate = cfg.sample_rate;
        let channels = cfg.channels;

        // 2-second HeapRb — T-06-02 mitigation: fixed capacity, push_slice
        // returns short count when full so samples are dropped (not
        // OOM-ed). Capacity sized generously so a slow drain never
        // causes permanent underflow.
        let buf_cap = (sample_rate as usize) * channels as usize * 2;
        let rb = HeapRb::<f32>::new(buf_cap.max(4096));
        let (mut prod, mut cons) = rb.split();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let degraded = Arc::new(AtomicBool::new(false));

        let degraded_for_err = degraded.clone();
        let err_cb = move |e: cpal::StreamError| {
            tracing::error!(target: "storycapture::audio", error = ?e, "cpal stream error");
            // Any StreamError — StreamInvalidated (mic unplug), device
            // gone, backend panic — flips the flag. The recording
            // orchestrator polls this and emits `audio://disconnected`
            // while the video pipeline continues (D-01 graceful
            // degradation).
            degraded_for_err.store(true, Ordering::Relaxed);
        };

        // Build the stream, branching on sample format. Only F32 + I16
        // are supported in v1 (covers ~all USB/Bluetooth/built-in mics;
        // exotic U16/F64 devices return UnsupportedFormat).
        let stream: Box<dyn StreamTrait + Send> = match sample_format {
            SampleFormat::F32 => {
                let s = device
                    .build_input_stream::<f32, _, _>(
                        &cfg,
                        move |data: &[f32], _: &_| {
                            // cpal#970 workaround — do NOT add any other
                            // cross-thread primitive here. push_slice is
                            // wait-free SPSC.
                            let _ = prod.push_slice(data);
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| AudioError::Cpal(format!("build_input_stream f32: {e}")))?;
                Box::new(s)
            }
            SampleFormat::I16 => {
                let s = device
                    .build_input_stream::<i16, _, _>(
                        &cfg,
                        move |data: &[i16], _: &_| {
                            // cpal#970 workaround — no cross-thread primitives.
                            // Convert i16 → f32 per-sample directly on the
                            // callback stack; no heap allocation (we
                            // push_slice in small chunks).
                            const CHUNK: usize = 512;
                            let mut buf = [0f32; CHUNK];
                            let mut i = 0;
                            while i < data.len() {
                                let n = (data.len() - i).min(CHUNK);
                                for k in 0..n {
                                    // i16::MAX as f32 → normalized [-1, 1]
                                    buf[k] = (data[i + k] as f32) / 32_768.0;
                                }
                                let _ = prod.push_slice(&buf[..n]);
                                i += n;
                            }
                        },
                        err_cb,
                        None,
                    )
                    .map_err(|e| AudioError::Cpal(format!("build_input_stream i16: {e}")))?;
                Box::new(s)
            }
            other => {
                return Err(AudioError::UnsupportedFormat(format!("{:?}", other)));
            }
        };

        let stop_for_thread = stop_flag.clone();
        let fifo_path_for_thread = fifo_path.clone();
        let drain_thread = std::thread::Builder::new()
            .name("storycapture-audio-drain".into())
            .spawn(move || {
                drain_loop(cons, stop_for_thread, fifo_path_for_thread);
            })
            .map_err(|e| AudioError::Fifo(format!("spawn drain thread: {e}")))?;

        stream
            .play()
            .map_err(|e| AudioError::Cpal(format!("stream.play: {e}")))?;

        let info = AudioStreamInfo {
            sample_rate,
            channels,
            format: SampleFormat::F32,
        };
        Ok((
            Self {
                _stream: stream,
                stop_flag,
                degraded,
                drain_thread: Some(drain_thread),
                info,
            },
            info,
        ))
    }

    /// Returns true if the cpal stream has reported an unrecoverable
    /// error since start (e.g., mic unplug). The host polls this and
    /// emits `audio://disconnected` when it flips, while letting the
    /// video pipeline finish.
    pub fn degraded(&self) -> bool {
        self.degraded.load(Ordering::Relaxed)
    }

    /// Shared handle on the degraded flag. Cloned into a tokio polling
    /// task so the host can emit a Tauri event without holding the
    /// AudioCaptureStream itself (which is !Sync because of cpal
    /// internals on some platforms).
    pub fn degraded_flag(&self) -> Arc<AtomicBool> {
        self.degraded.clone()
    }

    pub fn info(&self) -> AudioStreamInfo {
        self.info
    }
}

impl Drop for AudioCaptureStream {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        // _stream drops on struct drop → cpal pauses, callback stops.
        if let Some(h) = self.drain_thread.take() {
            let _ = h.join();
        }
    }
}

/// Drain the ringbuf into the named pipe in ~2 ms chunks. Runs on a
/// dedicated std::thread (NOT tokio) because the fifo open is blocking
/// and the write loop is bursty.
fn drain_loop(
    mut cons: impl Consumer<Item = f32>,
    stop_flag: Arc<AtomicBool>,
    fifo_path: PathBuf,
) {
    use std::io::Write;

    let mut fifo = match std::fs::OpenOptions::new()
        .write(true)
        .open(&fifo_path)
    {
        Ok(f) => f,
        Err(e) => {
            tracing::error!(
                target: "storycapture::audio",
                error = %e,
                "fifo open failed — drain thread exiting (is FFmpeg reading {}?)",
                fifo_path.display()
            );
            return;
        }
    };

    // 4096 samples × 4 bytes = 16 KiB per write. Matches FFmpeg's input
    // buffer sweet-spot for raw PCM.
    let mut buf = vec![0f32; 4096];
    while !stop_flag.load(Ordering::Relaxed) {
        let n = cons.pop_slice(&mut buf);
        if n == 0 {
            std::thread::sleep(std::time::Duration::from_millis(2));
            continue;
        }
        let bytes: &[u8] = bytemuck::cast_slice(&buf[..n]);
        if let Err(e) = fifo.write_all(bytes) {
            tracing::warn!(
                target: "storycapture::audio",
                error = %e,
                "fifo write failed — drain thread exiting (likely FFmpeg closed its end)"
            );
            break;
        }
    }
    // Final drain — pump whatever is left so the tail of the recording
    // isn't truncated.
    loop {
        let n = cons.pop_slice(&mut buf);
        if n == 0 {
            break;
        }
        let bytes: &[u8] = bytemuck::cast_slice(&buf[..n]);
        if fifo.write_all(bytes).is_err() {
            break;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// Mock path: synthetic 1 kHz sine @ 48 kHz mono. Compiled only when the
// `audio-mock` feature is enabled — keeps cpal-free CI honest and lets
// us assert sample-count invariants deterministically.
// ──────────────────────────────────────────────────────────────────────
#[cfg(feature = "audio-mock")]
mod mock {
    use super::*;

    pub(super) fn start_mock(
        fifo_path: PathBuf,
    ) -> Result<(AudioCaptureStream, AudioStreamInfo), AudioError> {
        let sample_rate = 48_000u32;
        let channels = 1u16;
        let info = AudioStreamInfo {
            sample_rate,
            channels,
            format: SampleFormat::F32,
        };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let degraded = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop_flag.clone();

        let fifo_path_clone = fifo_path.clone();
        // Single thread — synthesizes samples AND writes them. No cpal
        // callback to worry about; ringbuf hop is unnecessary for the
        // mock because we're the sole producer AND consumer. The test
        // verifies the wire-format byte rate, not the callback ↔ drain
        // decoupling (which is tested by the real cpal path on CI
        // hosts with mics).
        let drain_thread = std::thread::Builder::new()
            .name("storycapture-audio-drain-mock".into())
            .spawn(move || {
                use std::io::Write;
                let mut fifo = match std::fs::OpenOptions::new()
                    .write(true)
                    .open(&fifo_path_clone)
                {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::error!(target: "storycapture::audio", error = %e, "mock fifo open failed");
                        return;
                    }
                };
                // 1 kHz sine, full-scale 0.5 amplitude
                let freq = 1_000.0f32;
                let mut phase = 0.0f32;
                let step = 2.0 * std::f32::consts::PI * freq / sample_rate as f32;
                // ~10 ms chunks
                let chunk = (sample_rate as usize) / 100;
                let mut buf = vec![0f32; chunk];
                while !stop_for_thread.load(Ordering::Relaxed) {
                    for s in buf.iter_mut() {
                        *s = 0.5 * phase.sin();
                        phase += step;
                        if phase > std::f32::consts::TAU {
                            phase -= std::f32::consts::TAU;
                        }
                    }
                    let bytes: &[u8] = bytemuck::cast_slice(&buf);
                    if fifo.write_all(bytes).is_err() {
                        break;
                    }
                    // 10 ms sleep to pace the synth at realtime.
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            })
            .map_err(|e| AudioError::Fifo(format!("spawn mock drain: {e}")))?;

        struct NopStream;
        impl cpal::traits::StreamTrait for NopStream {
            fn play(&self) -> Result<(), cpal::PlayStreamError> {
                Ok(())
            }
            fn pause(&self) -> Result<(), cpal::PauseStreamError> {
                Ok(())
            }
        }

        let stream: Box<dyn StreamTrait + Send> = Box::new(NopStream);
        Ok((
            AudioCaptureStream {
                _stream: stream,
                stop_flag,
                degraded,
                drain_thread: Some(drain_thread),
                info,
            },
            info,
        ))
    }
}

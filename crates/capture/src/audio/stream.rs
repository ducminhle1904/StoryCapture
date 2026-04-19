//! cpal input stream plus ring buffer and drain thread for FFmpeg.
//!
//! FFmpeg must open the FIFO before `start()`, and the callback must only
//! use `push_slice` to avoid WASAPI stalls.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

use super::config::{
    negotiate_input, AudioStreamInfo, NegotiatedAudioInput, NegotiatedAudioSource,
};
use super::error::AudioError;

/// Sleep between empty ringbuf polls in the drain thread.
const DRAIN_EMPTY_SLEEP_MS: u64 = 2;

pub struct AudioCaptureStream {
    // Keep the cpal stream alive until drop.
    stream: Option<Box<dyn StreamTrait + Send>>,
    stop_flag: Arc<AtomicBool>,
    /// Set when the stream errors out mid-recording.
    degraded: Arc<AtomicBool>,
    drain_thread: Option<std::thread::JoinHandle<()>>,
    info: AudioStreamInfo,
}

impl AudioCaptureStream {
    /// Start capture.
    pub fn start(
        device_id: Option<&str>,
        fifo_path: PathBuf,
    ) -> Result<(Self, AudioStreamInfo), AudioError> {
        let negotiated = negotiate_input(device_id)?;
        Self::start_with_negotiated(negotiated, fifo_path)
    }

    /// Start capture from a config that was preflighted earlier.
    pub fn start_with_negotiated(
        negotiated: NegotiatedAudioInput,
        fifo_path: PathBuf,
    ) -> Result<(Self, AudioStreamInfo), AudioError> {
        let (source, cfg, sample_format, info) = negotiated.into_parts();
        match source {
            NegotiatedAudioSource::Device(device) => {
                start_cpal_stream(device, cfg, sample_format, info, fifo_path)
            }
            #[cfg(feature = "audio-mock")]
            NegotiatedAudioSource::Mock => mock::start_mock(fifo_path, info),
        }
    }

    pub fn info(&self) -> AudioStreamInfo {
        self.info
    }

    /// Returns true if the stream has errored.
    pub fn degraded(&self) -> bool {
        self.degraded.load(Ordering::Relaxed)
    }

    /// Cloneable degraded flag for host polling.
    pub fn degraded_flag(&self) -> Arc<AtomicBool> {
        self.degraded.clone()
    }

    pub fn pause(&self) -> Result<(), AudioError> {
        self.stream
            .as_ref()
            .ok_or_else(|| AudioError::Cpal("audio stream already stopped".into()))?
            .pause()
            .map_err(|e| AudioError::Cpal(format!("stream.pause: {e}")))
    }

    pub fn resume(&self) -> Result<(), AudioError> {
        self.stream
            .as_ref()
            .ok_or_else(|| AudioError::Cpal("audio stream already stopped".into()))?
            .play()
            .map_err(|e| AudioError::Cpal(format!("stream.play: {e}")))
    }
}

fn start_cpal_stream(
    device: Device,
    cfg: StreamConfig,
    sample_format: SampleFormat,
    info: AudioStreamInfo,
    fifo_path: PathBuf,
) -> Result<(AudioCaptureStream, AudioStreamInfo), AudioError> {
    let sample_rate = info.sample_rate;
    let channels = info.channels;

    // Fixed-capacity ring buffer; full writes drop samples.
    let buf_cap = (sample_rate as usize) * channels as usize * 2;
    let rb = HeapRb::<f32>::new(buf_cap.max(4096));
    let (mut prod, cons) = rb.split();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let degraded = Arc::new(AtomicBool::new(false));

    let degraded_for_err = degraded.clone();
    let err_cb = move |e: cpal::StreamError| {
        tracing::error!(target: "storycapture::audio", error = ?e, "cpal stream error");
        degraded_for_err.store(true, Ordering::Relaxed);
    };

    let stream: Box<dyn StreamTrait + Send> = match sample_format {
        SampleFormat::F32 => {
            let s = device
                .build_input_stream::<f32, _, _>(
                    &cfg,
                    move |data: &[f32], _: &_| {
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
                        const CHUNK: usize = 512;
                        let mut buf = [0f32; CHUNK];
                        let mut i = 0;
                        while i < data.len() {
                            let n = (data.len() - i).min(CHUNK);
                            for k in 0..n {
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
            return Err(AudioError::UnsupportedFormat(format!("{other:?}")));
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

    Ok((
        AudioCaptureStream {
            stream: Some(stream),
            stop_flag,
            degraded,
            drain_thread: Some(drain_thread),
            info,
        },
        info,
    ))
}

impl Drop for AudioCaptureStream {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.take() {
            drop(stream);
        }
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.drain_thread.take() {
            if handle.join().is_err() {
                tracing::warn!(target: "storycapture::audio", "drain thread panicked during drop");
            }
        }
    }
}

/// Drain the ring buffer into the named pipe on a dedicated thread.
fn drain_loop(mut cons: impl Consumer<Item = f32>, stop_flag: Arc<AtomicBool>, fifo_path: PathBuf) {
    use std::io::Write;

    let mut fifo = match std::fs::OpenOptions::new().write(true).open(&fifo_path) {
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

    // 16 KiB writes line up well with FFmpeg's raw PCM input buffer.
    let mut buf = vec![0f32; 4096];
    let mut total_samples: u64 = 0;
    let mut last_log_samples: u64 = 0;
    tracing::info!(target: "storycapture::audio", "drain thread: fifo opened");
    while !stop_flag.load(Ordering::Relaxed) {
        let n = cons.pop_slice(&mut buf);
        if n == 0 {
            std::thread::sleep(std::time::Duration::from_millis(DRAIN_EMPTY_SLEEP_MS));
            continue;
        }
        let bytes: &[u8] = bytemuck::cast_slice(&buf[..n]);
        if let Err(e) = fifo.write_all(bytes) {
            tracing::warn!(
                target: "storycapture::audio",
                error = %e,
                total_samples,
                "fifo write failed — drain thread exiting (likely FFmpeg closed its end)"
            );
            break;
        }
        total_samples += n as u64;
        if total_samples - last_log_samples >= 48_000 {
            tracing::info!(target: "storycapture::audio", total_samples, "drain progress (~1s of audio)");
            last_log_samples = total_samples;
        }
    }
    tracing::info!(target: "storycapture::audio", total_samples, stop_flag = stop_flag.load(Ordering::Relaxed), "drain main loop exited, entering final drain");
    // Final drain so the tail is not truncated.
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

// Mock path: synthetic 1 kHz sine @ 48 kHz mono.
#[cfg(feature = "audio-mock")]
mod mock {
    use super::*;

    pub(super) fn start_mock(
        fifo_path: PathBuf,
        info: AudioStreamInfo,
    ) -> Result<(AudioCaptureStream, AudioStreamInfo), AudioError> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let degraded = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop_flag.clone();

        let fifo_path_clone = fifo_path.clone();
        // Single thread synthesizes and writes samples.
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
                // 1 kHz sine, 0.5 amplitude.
                let freq = 1_000.0f32;
                let mut phase = 0.0f32;
                let step = 2.0 * std::f32::consts::PI * freq / info.sample_rate as f32;
                // ~10 ms chunks.
                let chunk = (info.sample_rate as usize) / 100;
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
                    // Pace the synth at realtime.
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
                stream: Some(stream),
                stop_flag,
                degraded,
                drain_thread: Some(drain_thread),
                info,
            },
            info,
        ))
    }
}

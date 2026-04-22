//! Cross-crate helpers that don't fit any single domain crate.

use sha2::{Digest, Sha256};

/// Callback fired when a frame is dropped somewhere in the capture→encoder
/// pipeline. Arguments are `(total_dropped, delta)` where `total_dropped` is
/// the monotonic running total and `delta` is the number of frames just
/// dropped by the current event (usually 1).
///
/// Used by both the capture backend (queue overflow) and the encoder (FFmpeg
/// stdin backpressure) so downstream telemetry can surface drops uniformly.
pub type FrameDropCallback = Box<dyn Fn(u64, u64) + Send + Sync>;

/// SHA-256 over the concatenation of `parts`, returned as a 64-char lowercase
/// hex string. Equivalent to `hex(sha256(parts[0] || parts[1] || ...))`.
///
/// Stable across runs; do not rely on the digest for cryptographic security
/// (the inputs are typically not secret — file paths, voice ids, URLs).
pub fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        assert_eq!(sha256_hex(&[b"a", b"b"]), sha256_hex(&[b"a", b"b"]));
    }

    #[test]
    fn input_sensitive() {
        assert_ne!(sha256_hex(&[b"a", b"b"]), sha256_hex(&[b"a", b"c"]));
    }

    #[test]
    fn matches_concat() {
        assert_eq!(sha256_hex(&[b"hello"]), sha256_hex(&[b"hel", b"lo"]));
    }
}

//! Cross-crate helpers that don't fit any single domain crate.
//!
//! Currently: a single SHA-256 hex helper used by the TTS cache and the
//! author-time snapshot store to derive stable filenames from variable-length
//! inputs.

use sha2::{Digest, Sha256};

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

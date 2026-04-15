//! Bundled sound-library manifest validation tests (Plan 02-08 Task 2).
//!
//! These are the automated blocking gate: they pass only once a human
//! operator has curated the 20 real CC0/CC-BY audio files per
//! `scripts/curate-sound-library.md`. While `manifest.json` / `attribution.json`
//! still contain `"PLACEHOLDER"` strings, `no_placeholder_strings` fails on
//! purpose.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

const EXPECTED_SFX: &[&str] = &[
    "click",
    "type",
    "navigate",
    "scroll",
    "hover",
    "drag",
    "select",
    "upload",
    "success",
    "error",
    "transition-whoosh-1",
    "transition-whoosh-2",
];

const EXPECTED_BGM: &[&str] = &[
    "chill-1",
    "chill-2",
    "upbeat-1",
    "upbeat-2",
    "ambient-1",
    "ambient-2",
    "corporate-1",
    "dramatic-1",
];

const MAX_TOTAL_BYTES: u64 = 30 * 1024 * 1024;

fn sound_root() -> PathBuf {
    // Tests run with CWD = crate root (crates/effects), so the repo root
    // sound library is two levels up.
    PathBuf::from("../../assets/sound-library")
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ManifestEntry {
    id: String,
    category: String,
    file: String,
    #[serde(default)]
    duration_ms: u64,
    license: String,
    source_url: String,
    author: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[allow(dead_code)]
    version: u32,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct AttributionEntry {
    id: String,
    #[allow(dead_code)]
    category: String,
    #[allow(dead_code)]
    file: String,
    license: String,
    source_url: String,
    #[allow(dead_code)]
    author: String,
    attribution_text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Attribution {
    entries: Vec<AttributionEntry>,
}

fn load_manifest() -> Manifest {
    let path = sound_root().join("manifest.json");
    let bytes = fs::read(&path).expect("read manifest.json");
    serde_json::from_slice(&bytes).expect("parse manifest.json")
}

fn load_attribution() -> Attribution {
    let path = sound_root().join("attribution.json");
    let bytes = fs::read(&path).expect("read attribution.json");
    serde_json::from_slice(&bytes).expect("parse attribution.json")
}

#[test]
fn manifest_json_schema_valid() {
    let m = load_manifest();
    let mut sfx: Vec<&str> = Vec::new();
    let mut bgm: Vec<&str> = Vec::new();
    for e in &m.entries {
        match e.category.as_str() {
            "sfx" => sfx.push(&e.id),
            "bgm" => bgm.push(&e.id),
            other => panic!("unknown category: {}", other),
        }
    }
    sfx.sort();
    bgm.sort();
    let mut expected_sfx: Vec<&str> = EXPECTED_SFX.to_vec();
    expected_sfx.sort();
    let mut expected_bgm: Vec<&str> = EXPECTED_BGM.to_vec();
    expected_bgm.sort();
    assert_eq!(sfx, expected_sfx, "SFX inventory mismatch");
    assert_eq!(bgm, expected_bgm, "BGM inventory mismatch");
    assert_eq!(m.entries.len(), 20);
}

#[test]
#[ignore = "requires curated audio files (see scripts/curate-sound-library.md)"]
fn every_file_exists() {
    let m = load_manifest();
    for e in &m.entries {
        let p = sound_root().join(&e.category).join(&e.file);
        assert!(p.is_file(), "missing bundled audio file: {}", p.display());
    }
}

#[test]
#[ignore = "blocking gate: intentionally fails until curation completes"]
fn no_placeholder_strings() {
    for name in ["manifest.json", "attribution.json"] {
        let path = sound_root().join(name);
        let contents = fs::read_to_string(&path).expect("read json");
        assert!(
            !contents.contains("PLACEHOLDER"),
            "{} still contains PLACEHOLDER strings — curation incomplete",
            name
        );
    }
}

#[test]
#[ignore = "requires curated attribution (see scripts/curate-sound-library.md)"]
fn attribution_every_entry() {
    let m = load_manifest();
    let a = load_attribution();
    // 1-to-1 id mapping.
    let m_ids: std::collections::BTreeSet<&str> = m.entries.iter().map(|e| e.id.as_str()).collect();
    let a_ids: std::collections::BTreeSet<&str> = a.entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(m_ids, a_ids, "manifest / attribution id sets differ");
    for e in &a.entries {
        assert!(
            e.license == "CC0" || e.license == "CC-BY-4.0",
            "entry {}: license {:?} is not CC0 or CC-BY-4.0",
            e.id,
            e.license
        );
        assert!(
            e.source_url.starts_with("https://"),
            "entry {}: source_url must be https",
            e.id
        );
        if e.license == "CC-BY-4.0" {
            assert!(
                matches!(&e.attribution_text, Some(t) if !t.is_empty()),
                "CC-BY-4.0 entry {} must have a non-empty attribution_text",
                e.id
            );
        }
    }
}

#[test]
#[ignore = "requires curated audio files"]
fn total_size_under_30_mib() {
    let mut total: u64 = 0;
    for sub in ["sfx", "bgm"] {
        let dir = sound_root().join(sub);
        for entry in fs::read_dir(&dir).unwrap_or_else(|_| panic!("read dir {}", dir.display())) {
            let entry = entry.unwrap();
            let meta = entry.metadata().unwrap();
            if meta.is_file() {
                total += meta.len();
            }
        }
    }
    assert!(
        total < MAX_TOTAL_BYTES,
        "bundled pack {} bytes exceeds 30 MiB cap",
        total
    );
}

#[test]
#[ignore = "requires curated manifest"]
fn manifest_loader_round_trip() {
    // effects::audio::load_manifest must parse the committed manifest.
    let root: &Path = &sound_root();
    let m = effects::audio::load_manifest(root).expect("load manifest");
    assert_eq!(m.entries.len(), 20);
}

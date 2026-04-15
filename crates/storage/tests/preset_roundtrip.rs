//! Integration tests for `.scpreset` file I/O and the 5 bundled defaults.
//!
//! Covers acceptance criteria for Phase 2 Plan 03 Task 3:
//!   - All 5 bundled files parse, report version=2, bundled=true.
//!   - export -> import round-trip preserves fields.
//!   - invalid kind → error.
//!   - too-new version → error.
//!   - install_bundled is idempotent (second run installs 0 new rows).

use std::path::PathBuf;
use storage::{
    export_preset, import_preset, repos::preset_repo, EffectPreset, PresetTier, ProjectDb,
};
use tempfile::tempdir;

fn bundled_dir() -> PathBuf {
    // tests/ resolves CWD to the crate root.
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    crate_root.join("../../assets/preset-defaults")
}

const BUNDLED_FILES: &[(&str, &str)] = &[
    ("linear.scpreset", "Linear"),
    ("runway.scpreset", "Runway Cinematic"),
    ("tella.scpreset", "Tella"),
    ("loom.scpreset", "Loom"),
    ("plain.scpreset", "Plain"),
];

#[test]
fn all_five_bundled_presets_parse() {
    for (fname, expected_name) in BUNDLED_FILES {
        let path = bundled_dir().join(fname);
        assert!(path.exists(), "missing bundled preset file: {}", path.display());
        let preset = import_preset(&path).expect(&format!("failed to import {fname}"));
        assert_eq!(preset.name, *expected_name, "name mismatch for {fname}");
        assert_eq!(preset.version, 2, "version != 2 for {fname}");
        assert!(preset.bundled, "bundled flag not set for {fname}");
        assert!(!preset.ast_json.is_empty(), "empty AST for {fname}");
        // Each AST must at least mention schema_version=2.
        assert!(
            preset.ast_json.contains("\"schema_version\""),
            "no schema_version in {fname}"
        );
    }
}

#[test]
fn export_then_import_roundtrip_preserves_fields() {
    let src = import_preset(&bundled_dir().join("runway.scpreset")).unwrap();

    let dir = tempdir().unwrap();
    let out = dir.path().join("exported.scpreset");
    export_preset(&src, &out).unwrap();

    let reimported = import_preset(&out).unwrap();

    // Compare semantic fields. `created_at` and `id` ride along because the
    // exporter embeds them.
    assert_eq!(reimported.id, src.id);
    assert_eq!(reimported.name, src.name);
    assert_eq!(reimported.description, src.description);
    assert_eq!(reimported.version, src.version);
    assert_eq!(reimported.bundled, src.bundled);
    assert_eq!(reimported.tags, src.tags);
    assert_eq!(reimported.author, src.author);

    // AST equality: compare parsed JSON so whitespace doesn't matter.
    let a: serde_json::Value = serde_json::from_str(&src.ast_json).unwrap();
    let b: serde_json::Value = serde_json::from_str(&reimported.ast_json).unwrap();
    assert_eq!(a, b);
}

#[test]
fn invalid_kind_rejected() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("bad.scpreset");
    std::fs::write(
        &p,
        r#"{
            "version": 2, "kind": "oops", "name": "X", "description": "",
            "bundled": false, "ast": {}, "metadata": {"author":"","created_at":0,"tags":[]}
        }"#,
    )
    .unwrap();
    assert!(import_preset(&p).is_err());
}

#[test]
fn too_new_version_rejected() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("future.scpreset");
    std::fs::write(
        &p,
        r#"{
            "version": 99, "kind": "effect_preset", "name": "X", "description": "",
            "bundled": false, "ast": {}, "metadata": {"author":"","created_at":0,"tags":[]}
        }"#,
    )
    .unwrap();
    assert!(import_preset(&p).is_err());
}

#[test]
fn install_bundled_is_idempotent() {
    let dir = tempdir().unwrap();
    let db = ProjectDb::open(dir.path()).unwrap();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let n1 = preset_repo::install_bundled(&conn, PresetTier::Project, &bundled_dir()).unwrap();
    assert_eq!(n1, 5, "expected all 5 bundled presets installed first run");

    // Second run must insert zero new rows (INSERT OR IGNORE on stable ids).
    let n2 = preset_repo::install_bundled(&conn, PresetTier::Project, &bundled_dir()).unwrap();
    assert_eq!(n2, 0, "second run must be a no-op");

    let listed = preset_repo::list_by_scope(&conn, PresetTier::Project).unwrap();
    assert_eq!(listed.len(), 5);
    // Each listed preset's name must match one from the fixture table.
    let expected: std::collections::HashSet<_> =
        BUNDLED_FILES.iter().map(|(_, n)| *n).collect();
    for p in &listed {
        assert!(
            expected.contains(p.name.as_str()),
            "unexpected bundled preset name: {}",
            p.name
        );
        assert!(p.bundled);
    }

    // Silence unused db warning.
    let _ = db.schema_version();
}

#[test]
fn size_guard_rejects_huge_files() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("huge.scpreset");
    // Write a file just over the 5 MiB cap; the header alone is invalid JSON
    // but the size guard must fire before JSON parsing.
    let mut data = vec![b'x'; (storage::MAX_SCPRESET_BYTES + 16) as usize];
    data[0] = b'{';
    std::fs::write(&p, &data).unwrap();
    assert!(import_preset(&p).is_err());
}

/// Catch-all: compile-time sanity that the public re-export surface is usable
/// from a downstream crate.
#[allow(dead_code)]
fn _type_sanity(_p: EffectPreset, _t: PresetTier) {}

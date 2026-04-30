// Pitfall 5 regression guard for D-04: re-stamp is idempotent at the
// source-byte level. If a future change moves `std::fs::write` out of the
// `None` arm of `picker_stamp_step_id`'s match, these tests fail.

use std::fs;
use std::thread;
use std::time::Duration;

use storycapture::commands::picker::{stamp_step_id_impl, TargetRecordDto};

/// A typed testid target with a stable value — keeps the `targets.json`
/// write path exercised without depending on generator-specific outputs.
fn primary() -> TargetRecordDto {
    TargetRecordDto::Testid {
        value: "save-btn".into(),
        nth: None,
    }
}

#[test]
fn restamp_on_already_stamped_line_does_not_rewrite_source() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("demo.story");
    // Line 4 carries the @id trailer — the stamp function must short-circuit
    // through its Some(existing_id) arm without rewriting the file.
    let src = concat!(
        "story \"t\" {\n",
        "  scene \"s\" {\n",
        "    click button \"Save\"  # @id=01890000-0000-7000-8000-000000000001\n",
        "  }\n",
        "}\n",
    );
    fs::write(&path, src).unwrap();
    let before = fs::read(&path).unwrap();
    let before_mtime = fs::metadata(&path).unwrap().modified().unwrap();

    // Sleep briefly so the filesystem mtime granularity could register a
    // change if the code were to rewrite the file (guards against false
    // negatives on coarse-resolution filesystems).
    thread::sleep(Duration::from_millis(20));

    let result = stamp_step_id_impl(
        path.to_string_lossy().into_owned(),
        3,
        primary(),
        Vec::new(),
    )
    .expect("stamp_step_id_impl should succeed on an already-stamped line");

    assert_eq!(
        result.step_id, "01890000-0000-7000-8000-000000000001",
        "returned step_id must equal the existing stamped UUID"
    );
    assert!(
        !result.was_freshly_stamped,
        "re-pick on stamped line must return was_freshly_stamped=false"
    );

    let after = fs::read(&path).unwrap();
    assert_eq!(
        before, after,
        "D-04: source bytes MUST be byte-identical after re-stamp on stamped line"
    );

    let after_mtime = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(
        before_mtime, after_mtime,
        "Pitfall 5: source mtime must not change on re-stamp"
    );

    // Sanity: targets.json IS (re)written on every pick — that's normal.
    let targets = path.with_extension("story.targets.json");
    assert!(
        targets.exists(),
        "targets.json should be seeded even on re-stamp"
    );
}

#[test]
fn stamp_on_unstamped_line_writes_source() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("demo.story");
    let src = concat!(
        "story \"t\" {\n",
        "  scene \"s\" {\n",
        "    click button \"Save\"\n",
        "  }\n",
        "}\n",
    );
    fs::write(&path, src).unwrap();
    let before = fs::read(&path).unwrap();

    let result = stamp_step_id_impl(
        path.to_string_lossy().into_owned(),
        3,
        primary(),
        Vec::new(),
    )
    .expect("stamp_step_id_impl should succeed on an unstamped line");

    assert!(
        result.was_freshly_stamped,
        "first stamp on unstamped line must return was_freshly_stamped=true"
    );
    assert_eq!(
        result.step_id.len(),
        36,
        "freshly-minted UUIDv7 should be a 36-char hyphenated string"
    );

    let after = fs::read(&path).unwrap();
    assert_ne!(
        before, after,
        "first stamp on unstamped line must rewrite the source with the @id trailer"
    );
    assert!(
        String::from_utf8_lossy(&after).contains(&result.step_id),
        "rewritten source must contain the minted UUID"
    );

    let targets = path.with_extension("story.targets.json");
    assert!(
        targets.exists(),
        "targets.json should be seeded on first stamp"
    );
}

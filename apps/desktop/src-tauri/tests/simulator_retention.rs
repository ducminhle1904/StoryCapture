//! Phase 10-02 Task 1 — `prune_runs_retain_5` retention-trim tests.

use std::fs;
use std::time::{Duration, SystemTime};

use storycapture::prune_runs_retain_5;

fn touch(dir: &std::path::Path, age_secs: u64) {
    fs::create_dir_all(dir).unwrap();
    let t = SystemTime::now() - Duration::from_secs(age_secs);
    filetime::set_file_mtime(dir, filetime::FileTime::from_system_time(t)).unwrap();
}

#[test]
fn retains_only_5_most_recent() {
    let project = tempfile::tempdir().unwrap();
    let sim = project.path().join(".story.simulator");
    fs::create_dir_all(&sim).unwrap();
    for i in 0..7u64 {
        touch(&sim.join(format!("run-{i}")), i * 10); // 0 = newest
    }
    let deleted = prune_runs_retain_5(project.path()).unwrap();
    assert_eq!(deleted, 2);
    let remaining: Vec<String> = fs::read_dir(&sim)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(remaining.len(), 5);
    assert!(!remaining.contains(&"run-5".to_string()));
    assert!(!remaining.contains(&"run-6".to_string()));
}

#[test]
fn under_5_keeps_all() {
    let project = tempfile::tempdir().unwrap();
    let sim = project.path().join(".story.simulator");
    fs::create_dir_all(&sim).unwrap();
    for i in 0..3u64 {
        touch(&sim.join(format!("run-{i}")), i * 10);
    }
    let deleted = prune_runs_retain_5(project.path()).unwrap();
    assert_eq!(deleted, 0);
    assert_eq!(fs::read_dir(&sim).unwrap().count(), 3);
}

#[test]
fn missing_dir_is_created() {
    let project = tempfile::tempdir().unwrap();
    let deleted = prune_runs_retain_5(project.path()).unwrap();
    assert_eq!(deleted, 0);
    assert!(project.path().join(".story.simulator").exists());
}

//! DSL → driver dispatch with capability routing + auto-wait wrap.
//!
//! Every command is dispatched through:
//!
//! 1. [`crate::capability::required_for`] — figure out the capability tag.
//! 2. [`crate::capability::driver_for`] — pick `primary` or `fallback`.
//! 3. [`crate::driver::BrowserDriver::resolve_selector`] — SmartSelector run.
//! 4. [`crate::auto_wait::wait_actionable`] — Playwright-style precondition.
//! 5. The verb-specific driver method.
//!
//! Events flow out through an `mpsc::Receiver<ExecutorEvent>` (D-06 actor
//! pattern). The optional `ProjectDb` writer persists the session/step/
//! attempt rows (Plan 05 surface).

use crate::capability::{driver_for, required_for};
use crate::driver::{ActionKind, BrowserDriver, LaunchConfig, LaunchOptions};
use crate::error::{AutomationError, Result};
use crate::events::{AttemptLog, ExecutorEvent, StorySummary};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use storage::{NewAttempt, NewSession, NewStep, ProjectDb, SessionStatus, StepStatus};
use story_parser::{Command, Story};
use tokio::sync::{mpsc, Mutex};

const DEFAULT_ACTION_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_WAITFOR_TIMEOUT_MS: u64 = 30_000;

pub type PersistenceHandle = Arc<Mutex<ProjectDb>>;

pub struct Executor;

impl Executor {
    /// Run a story end-to-end. Returns immediately with the event receiver;
    /// the actual execution happens in a spawned tokio task.
    pub fn run(
        story: Story,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
    ) -> mpsc::Receiver<ExecutorEvent> {
        let (tx, rx) = mpsc::channel::<ExecutorEvent>(256);
        tokio::spawn(async move {
            let _ = run_story(
                story,
                primary,
                fallback,
                persistence,
                screenshot_dir,
                launch_opts,
                tx,
            )
            .await;
        });
        rx
    }

    /// Test-only synchronous dispatcher. Picks the right driver for `cmd`
    /// and returns it (no execution). Used by `tests/capability_routing.rs`
    /// to assert routing without spinning the full executor.
    pub fn pick_driver_for_cmd<'a>(
        primary: &'a dyn BrowserDriver,
        fallback: &'a dyn BrowserDriver,
        cmd: &Command,
    ) -> &'a dyn BrowserDriver {
        let cap = required_for(cmd);
        driver_for(primary, fallback, cap)
    }
}

async fn run_story(
    story: Story,
    mut primary: Box<dyn BrowserDriver>,
    mut fallback: Box<dyn BrowserDriver>,
    persistence: Option<PersistenceHandle>,
    screenshot_dir: PathBuf,
    launch_opts: LaunchOptions,
    tx: mpsc::Sender<ExecutorEvent>,
) -> Result<()> {
    let started = Instant::now();
    let story_hash = hash_story(&story);
    let _ = tx
        .send(ExecutorEvent::StoryStarted {
            story_hash: story_hash.clone(),
        })
        .await;

    // Launch both drivers. Errors during launch are fatal for the session
    // (we can't dispatch anything without an open page).
    let launch_cfg = LaunchConfig::from_meta(&story.meta, &launch_opts);
    primary.launch(launch_cfg.clone()).await?;
    fallback.launch(launch_cfg.clone()).await.ok(); // playwright sidecar may not be wired in unit tests

    // Persistence: open a session row.
    let session_id = if let Some(db) = persistence.as_ref() {
        let mut g = db.lock().await;
        Some(g.insert_session(NewSession {
            story_hash: story_hash.clone(),
            meta_json: serde_json::to_string(&story.meta).unwrap_or_default(),
        })?)
    } else {
        None
    };

    let mut total: u32 = 0;
    let mut succeeded: u32 = 0;
    let mut failed: u32 = 0;
    let mut ordinal: u32 = 0;

    'scenes: for (i, scene) in story.scenes.iter().enumerate() {
        let _ = tx
            .send(ExecutorEvent::SceneEntered {
                name: scene.name.clone(),
                ordinal: i as u32,
            })
            .await;
        for cmd in &scene.commands {
            ordinal += 1;
            total += 1;
            let driver = Executor::pick_driver_for_cmd(primary.as_ref(), fallback.as_ref(), cmd);
            let driver_name = driver.name();

            let _ = tx
                .send(ExecutorEvent::StepStarted {
                    ordinal,
                    command: cmd.clone(),
                    driver_used: driver_name.into(),
                })
                .await;

            let step_id = if let (Some(db), Some(sid)) = (persistence.as_ref(), session_id) {
                let mut g = db.lock().await;
                Some(
                    g.append_step(
                        sid,
                        NewStep {
                            ordinal,
                            command_json: serde_json::to_string(cmd).unwrap_or_default(),
                        },
                    )?,
                )
            } else {
                None
            };

            let cmd_started = Instant::now();
            let result =
                run_command(driver, cmd, &screenshot_dir, &tx, ordinal, &persistence, step_id)
                    .await;

            match result {
                Ok(()) => {
                    succeeded += 1;
                    let (cx, cy) = driver.current_cursor_position().await.unwrap_or((0, 0));
                    let _ = tx
                        .send(ExecutorEvent::StepSucceeded {
                            ordinal,
                            duration_ms: cmd_started.elapsed().as_millis() as u64,
                            cursor_x: cx,
                            cursor_y: cy,
                        })
                        .await;
                    if let (Some(db), Some(sid)) = (persistence.as_ref(), step_id) {
                        let mut g = db.lock().await;
                        let _ = g.complete_step(sid, StepStatus::Succeeded, None);
                    }
                }
                Err((err, attempts)) => {
                    failed += 1;
                    let screenshot_path = match driver.screenshot(&format!("step-{ordinal}-fail"), &screenshot_dir).await {
                        Ok(p) => Some(p),
                        Err(_) => None,
                    };
                    let _ = tx
                        .send(ExecutorEvent::StepFailed {
                            ordinal,
                            attempts,
                            error_message: err.to_string(),
                            screenshot_path: screenshot_path.clone(),
                        })
                        .await;
                    if let (Some(db), Some(sid)) = (persistence.as_ref(), step_id) {
                        let mut g = db.lock().await;
                        let msg = err.to_string();
                        let _ = g.complete_step(sid, StepStatus::Failed, Some(&msg));
                    }
                    // Phase 1 policy: stop on first failure. The UI surfaces
                    // a retry / skip choice in Phase 3.
                    break 'scenes;
                }
            }
        }
    }

    let summary = StorySummary {
        total_steps: total,
        succeeded,
        failed,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    let _ = tx
        .send(ExecutorEvent::StoryEnded {
            status: summary.clone(),
        })
        .await;

    if let (Some(db), Some(sid)) = (persistence.as_ref(), session_id) {
        let mut g = db.lock().await;
        let final_status = if failed == 0 {
            SessionStatus::Completed
        } else {
            SessionStatus::Failed
        };
        let _ = g.complete_session(sid, final_status);
    }
    Ok(())
}

async fn run_command(
    driver: &dyn BrowserDriver,
    cmd: &Command,
    screenshot_dir: &std::path::Path,
    tx: &mpsc::Sender<ExecutorEvent>,
    ordinal: u32,
    persistence: &Option<PersistenceHandle>,
    step_id: Option<uuid::Uuid>,
) -> std::result::Result<(), (AutomationError, Vec<AttemptLog>)> {
    let mut attempts: Vec<AttemptLog> = Vec::new();

    macro_rules! resolve {
        ($target:expr, $action:expr) => {{
            match crate::selector::resolve_via_smart(
                driver,
                $action,
                $target,
                DEFAULT_ACTION_TIMEOUT_MS,
            )
            .await
            {
                Ok((sel, atts)) => {
                    push_attempts(&atts, tx, ordinal, persistence, step_id, None).await;
                    attempts.extend(atts);
                    sel
                }
                Err(e) => return Err((e, attempts)),
            }
        }};
    }

    macro_rules! wait_actionable {
        ($sel:expr) => {{
            if let Err(e) =
                crate::auto_wait::wait_actionable(driver, &$sel, DEFAULT_ACTION_TIMEOUT_MS).await
            {
                return Err((e, attempts));
            }
        }};
    }

    let result = match cmd {
        Command::Navigate { url, .. } => driver.goto(url).await,
        Command::Click { target, .. } => {
            let sel = resolve!(target, ActionKind::Click);
            wait_actionable!(sel);
            driver.click(&sel).await
        }
        Command::Type { target, text, .. } => {
            let sel = resolve!(target, ActionKind::Type);
            wait_actionable!(sel);
            driver.type_text(&sel, text).await
        }
        Command::Scroll {
            direction, amount, ..
        } => driver.scroll(*direction, *amount).await,
        Command::Hover { target, .. } => {
            let sel = resolve!(target, ActionKind::Hover);
            wait_actionable!(sel);
            driver.hover(&sel).await
        }
        Command::Drag { from, to, .. } => {
            let sf = resolve!(from, ActionKind::Drag);
            let st = resolve!(to, ActionKind::Drag);
            wait_actionable!(sf);
            wait_actionable!(st);
            driver.drag(&sf, &st).await
        }
        Command::Select { target, value, .. } => {
            let sel = resolve!(target, ActionKind::Select);
            wait_actionable!(sel);
            driver.select_option(&sel, value).await
        }
        Command::Upload { target, path, .. } => {
            let sel = resolve!(target, ActionKind::Upload);
            driver.upload_file(&sel, std::path::Path::new(path)).await
        }
        Command::Wait { duration_ms, .. } => driver.wait_ms(*duration_ms).await,
        Command::WaitFor {
            target, timeout_ms, ..
        } => {
            driver
                .wait_for(target, timeout_ms.unwrap_or(DEFAULT_WAITFOR_TIMEOUT_MS))
                .await
        }
        Command::Assert { target, .. } => driver.assert_present(target).await,
        Command::Screenshot { name, .. } => driver.screenshot(name, screenshot_dir).await.map(|_| ()),
        Command::Pause { .. } => Ok(()),
    };

    result.map_err(|e| (e, attempts))
}

async fn push_attempts(
    atts: &[AttemptLog],
    tx: &mpsc::Sender<ExecutorEvent>,
    ordinal: u32,
    persistence: &Option<PersistenceHandle>,
    step_id: Option<uuid::Uuid>,
    screenshot_path: Option<PathBuf>,
) {
    for a in atts {
        let _ = tx
            .send(ExecutorEvent::StepAttempt {
                step_ordinal: ordinal,
                attempt: a.clone(),
            })
            .await;
        if let (Some(db), Some(sid)) = (persistence, step_id) {
            let mut g = db.lock().await;
            let _ = g.append_attempt(
                sid,
                NewAttempt {
                    selector_strategy: a.strategy.as_str().into(),
                    selector_value: a.value.clone(),
                    outcome: format!("{:?}", a.outcome),
                    screenshot_path: screenshot_path.clone(),
                },
            );
        }
    }
}

/// Suppressed-collision content hash (used as a story-fingerprint key in
/// the `sessions` table). Not cryptographic — just a stable id.
fn hash_story(story: &Story) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    if let Ok(json) = serde_json::to_string(story) {
        json.hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}

/// Re-export so downstream code can `use automation::ExecutorEvent`.
pub use crate::events::ExecutorEvent as Event;

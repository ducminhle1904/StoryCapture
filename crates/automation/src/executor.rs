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
use crate::control::RunControl;
use crate::driver::{ActionKind, BrowserDriver, LaunchConfig, LaunchOptions, ResolvedSelector};
use crate::error::{AutomationError, Result};
use crate::events::{AttemptLog, ExecutorEvent, MatchKind, StepFrame, StorySummary};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use storage::{NewAttempt, NewSession, NewStep, ProjectDb, SessionStatus, StepStatus};
use story_parser::{Command, Story};
use tokio::sync::{mpsc, Mutex};

const DEFAULT_ACTION_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_WAITFOR_TIMEOUT_MS: u64 = 30_000;
const PAUSE_POLL_SLICE_MS: u64 = 50;

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
        control: Option<Arc<RunControl>>,
    ) -> mpsc::Receiver<ExecutorEvent> {
        Self::run_with_story_path(
            story,
            None,
            primary,
            fallback,
            persistence,
            screenshot_dir,
            launch_opts,
            control,
        )
    }

    /// Variant of [`Executor::run`] that threads a `.story` source path for
    /// the self-healing sidecar targets store (plan 07-04c / PHASE-7.5).
    /// When `story_path` is `Some`, a command whose `meta.step_id` is set
    /// and whose primary selector fails `wait_actionable` will consult
    /// `<story_path>.targets.json`, iterate fallbacks, and atomically
    /// rewrite the sidecar on promotion. Passing `None` disables the
    /// self-healing hook (legacy callers / headless usage).
    pub fn run_with_story_path(
        story: Story,
        story_path: Option<PathBuf>,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
        control: Option<Arc<RunControl>>,
    ) -> mpsc::Receiver<ExecutorEvent> {
        let (tx, rx) = mpsc::channel::<ExecutorEvent>(256);
        tokio::spawn(async move {
            let _ = run_story(
                story,
                story_path,
                primary,
                fallback,
                persistence,
                screenshot_dir,
                launch_opts,
                control,
                None,
                false,
                None,
                true,
                tx,
            )
            .await;
        });
        rx
    }

    /// Simulator-mode runner (Phase 10-01). Variant of `run_with_story_path`
    /// that threads the four new simulator params — `stop_after_ordinal`,
    /// `capture_frames`, `frame_dir`, `self_heal` — through to `run_story`.
    /// Recording path callers should stay on `run_with_story_path`.
    #[allow(clippy::too_many_arguments)]
    pub fn run_simulator(
        story: Story,
        story_path: Option<PathBuf>,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
        control: Option<Arc<RunControl>>,
        stop_after_ordinal: Option<u32>,
        capture_frames: bool,
        frame_dir: Option<PathBuf>,
        self_heal: bool,
    ) -> mpsc::Receiver<ExecutorEvent> {
        let (tx, rx) = mpsc::channel::<ExecutorEvent>(256);
        tokio::spawn(async move {
            let _ = run_story(
                story,
                story_path,
                primary,
                fallback,
                persistence,
                screenshot_dir,
                launch_opts,
                control,
                stop_after_ordinal,
                capture_frames,
                frame_dir,
                self_heal,
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

#[allow(clippy::too_many_arguments)]
async fn run_story(
    story: Story,
    story_path: Option<PathBuf>,
    mut primary: Box<dyn BrowserDriver>,
    mut fallback: Box<dyn BrowserDriver>,
    persistence: Option<PersistenceHandle>,
    screenshot_dir: PathBuf,
    launch_opts: LaunchOptions,
    control: Option<Arc<RunControl>>,
    stop_after_ordinal: Option<u32>,
    capture_frames: bool,
    frame_dir: Option<PathBuf>,
    self_heal: bool,
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
        checkpoint(control.as_deref()).await;
        let _ = tx
            .send(ExecutorEvent::SceneEntered {
                name: scene.name.clone(),
                ordinal: i as u32,
            })
            .await;
        for cmd in &scene.commands {
            checkpoint(control.as_deref()).await;
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
                Some(g.append_step(
                    sid,
                    NewStep {
                        ordinal,
                        command_json: serde_json::to_string(cmd).unwrap_or_default(),
                    },
                )?)
            } else {
                None
            };

            let cmd_started = Instant::now();
            let result = run_command(
                driver,
                cmd,
                &screenshot_dir,
                &tx,
                ordinal,
                &persistence,
                step_id,
                control.as_deref(),
                story_path.as_deref(),
                self_heal,
            )
            .await;

            match result {
                Ok(last_resolved) => {
                    succeeded += 1;
                    let (cx, cy) = driver.current_cursor_position().await.unwrap_or((0, 0));
                    let duration_ms = cmd_started.elapsed().as_millis() as u64;
                    let _ = tx
                        .send(ExecutorEvent::StepSucceeded {
                            ordinal,
                            duration_ms,
                            cursor_x: cx,
                            cursor_y: cy,
                        })
                        .await;
                    if let (Some(db), Some(sid)) = (persistence.as_ref(), step_id) {
                        let mut g = db.lock().await;
                        let _ = g.complete_step(sid, StepStatus::Succeeded, None);
                    }

                    if capture_frames {
                        let shot_path = if let Some(dir) = frame_dir.as_deref() {
                            driver
                                .screenshot(&format!("frame-{ordinal}"), dir)
                                .await
                                .ok()
                        } else {
                            None
                        };
                        let (matched_selector, matched_bbox, match_kind) = match last_resolved
                            .as_ref()
                        {
                            Some((rs, kind)) => {
                                let state = driver.element_state(rs).await.ok();
                                (
                                    Some(rs.value.clone()),
                                    state.and_then(|s| s.bbox),
                                    *kind,
                                )
                            }
                            None => (None, None, MatchKind::None),
                        };
                        let frame = StepFrame {
                            ordinal,
                            screenshot_path: shot_path,
                            cursor_xy: (cx, cy),
                            matched_selector,
                            matched_bbox,
                            match_kind,
                            duration_ms,
                        };
                        let _ = tx
                            .send(ExecutorEvent::StepFrameCaptured { ordinal, frame })
                            .await;
                    }

                    if stop_after_ordinal == Some(ordinal) {
                        let _ = tx.send(ExecutorEvent::RunPaused { ordinal }).await;
                        return Ok(());
                    }
                }
                Err((err, attempts)) => {
                    failed += 1;
                    let screenshot_path = match driver
                        .screenshot(&format!("step-{ordinal}-fail"), &screenshot_dir)
                        .await
                    {
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

#[allow(clippy::too_many_arguments)]
async fn run_command(
    driver: &dyn BrowserDriver,
    cmd: &Command,
    screenshot_dir: &std::path::Path,
    tx: &mpsc::Sender<ExecutorEvent>,
    ordinal: u32,
    persistence: &Option<PersistenceHandle>,
    step_id: Option<uuid::Uuid>,
    control: Option<&RunControl>,
    story_path: Option<&std::path::Path>,
    self_heal: bool,
) -> std::result::Result<Option<(ResolvedSelector, MatchKind)>, (AutomationError, Vec<AttemptLog>)>
{
    let mut attempts: Vec<AttemptLog> = Vec::new();
    let mut last_resolved: Option<(ResolvedSelector, MatchKind)> = None;
    checkpoint(control).await;

    // Step_id from the DSL line itself (plan 07-04b `# @id=<uuidv7>`), used
    // by the self-healing path to key into the targets sidecar. Distinct
    // from the `step_id` param, which is the storage row id.
    let cmd_step_id = cmd.step_id();

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
                    // First resolve wins for simulator display (Drag's
                    // `from` carries the user-authored target identity).
                    if last_resolved.is_none() {
                        last_resolved = Some((sel.clone(), MatchKind::Primary));
                    }
                    sel
                }
                Err(e) => return Err((e, attempts)),
            }
        }};
    }

    // Wait-actionable with self-healing fallback promotion (plan 07-04c).
    //
    // When the primary selector's wait_actionable times out AND the command
    // has a stamped step_id AND a `.story.targets.json` sidecar is present
    // with fallbacks for that step, we iterate the fallbacks. The first one
    // that resolves + passes wait_actionable is promoted to primary (the old
    // primary becomes fallbacks[0]) and the sidecar JSON is rewritten
    // atomically — the `.story` source is NEVER modified.
    //
    // The macro returns the (possibly promoted) `ResolvedSelector` to use
    // for the subsequent action.
    macro_rules! wait_actionable_or_heal {
        ($sel:expr, $action:expr) => {{
            let mut current: crate::driver::ResolvedSelector = $sel;
            match crate::auto_wait::wait_actionable(driver, &current, DEFAULT_ACTION_TIMEOUT_MS)
                .await
            {
                Ok(()) => current,
                Err(primary_err) => {
                    // Probe fallbacks regardless of self_heal so the
                    // simulator can surface match_kind=Fuzzy even in
                    // read-only runs; only persist the promotion when
                    // self_heal=true (D-07).
                    match try_promote_fallback(
                        driver,
                        cmd_step_id,
                        story_path,
                        $action,
                        self_heal,
                    )
                    .await
                    {
                        Ok(Some(promoted)) => {
                            last_resolved = Some((promoted.clone(), MatchKind::Fuzzy));
                            current = promoted;
                            current
                        }
                        Ok(None) => return Err((primary_err, attempts)),
                        Err(e) => return Err((e, attempts)),
                    }
                }
            }
        }};
    }

    let result = match cmd {
        Command::Navigate { url, .. } => driver.goto(url).await,
        Command::Click { target, .. } => {
            let sel = resolve!(target, ActionKind::Click);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Click);
            driver.click(&sel).await
        }
        Command::Type { target, text, .. } => {
            let sel = resolve!(target, ActionKind::Type);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Type);
            driver.type_text(&sel, text).await
        }
        Command::Scroll {
            direction, amount, ..
        } => driver.scroll(*direction, *amount).await,
        Command::Hover { target, .. } => {
            let sel = resolve!(target, ActionKind::Hover);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Hover);
            driver.hover(&sel).await
        }
        Command::Drag { from, to, .. } => {
            let sf = resolve!(from, ActionKind::Drag);
            let st = resolve!(to, ActionKind::Drag);
            // Self-healing for drag targets: only the FROM is healed; the
            // TO side is a drop target whose identity is paired with the
            // source, so mutating it in isolation is unsafe.
            let sf = wait_actionable_or_heal!(sf, ActionKind::Drag);
            if let Err(e) =
                crate::auto_wait::wait_actionable(driver, &st, DEFAULT_ACTION_TIMEOUT_MS).await
            {
                return Err((e, attempts));
            }
            driver.drag(&sf, &st).await
        }
        Command::Select { target, value, .. } => {
            let sel = resolve!(target, ActionKind::Select);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Select);
            driver.select_option(&sel, value).await
        }
        Command::Upload { target, path, .. } => {
            let sel = resolve!(target, ActionKind::Upload);
            driver.upload_file(&sel, std::path::Path::new(path)).await
        }
        Command::Wait { duration_ms, .. } => wait_with_pause(*duration_ms, control, driver).await,
        Command::WaitFor {
            target, timeout_ms, ..
        } => {
            driver
                .wait_for(target, timeout_ms.unwrap_or(DEFAULT_WAITFOR_TIMEOUT_MS))
                .await
        }
        Command::Assert { target, .. } => driver.assert_present(target).await,
        Command::Screenshot { name, .. } => {
            driver.screenshot(name, screenshot_dir).await.map(|_| ())
        }
        Command::Pause { .. } => Ok(()),
    };

    result.map(|()| last_resolved).map_err(|e| (e, attempts))
}

/// Plan 07-04c self-healing hook. On a primary `wait_actionable` miss,
/// consult `<story_path>.targets.json` for the step's fallbacks, iterate
/// them in order, and return the first one that resolves + passes
/// `wait_actionable`. On success rewrites the sidecar JSON atomically —
/// the old primary is demoted to `fallbacks[0]` and the winning fallback
/// takes its place.
///
/// Returns:
/// - `Ok(Some(resolved))` — promotion succeeded, caller should use the
///   returned selector for the action.
/// - `Ok(None)` — no step_id, no sidecar, or no fallback passed; caller
///   should surface the original primary-miss error.
/// - `Err(_)` — sidecar read/write or resolver error (distinct from the
///   primary-miss, surfaced instead of it).
///
/// Commands with `step_id == None` skip the self-healing path entirely —
/// legacy stories are NEVER touched by the targets store.
pub async fn try_promote_fallback(
    driver: &dyn BrowserDriver,
    cmd_step_id: Option<uuid::Uuid>,
    story_path: Option<&std::path::Path>,
    action: ActionKind,
    persist: bool,
) -> Result<Option<crate::driver::ResolvedSelector>> {
    let Some(step_id) = cmd_step_id else {
        return Ok(None);
    };
    let Some(story_path) = story_path else {
        return Ok(None);
    };

    let targets_path = crate::targets_store::targets_path_for(story_path);
    let mut store = match crate::targets_store::load(&targets_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                target: "storycapture::automation::self_healing",
                error = %e,
                "failed to load targets sidecar; self-healing disabled for this step"
            );
            return Ok(None);
        }
    };

    let Some(mut step) = store.steps.get(&step_id).cloned() else {
        return Ok(None);
    };
    if step.fallbacks.is_empty() {
        return Ok(None);
    }

    for (idx, fallback) in step.fallbacks.clone().into_iter().enumerate() {
        let target = match crate::targets_store::target_record_to_selector(&fallback) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    target: "storycapture::automation::self_healing",
                    kind = %fallback.kind,
                    error = %e,
                    "skipping malformed fallback record"
                );
                continue;
            }
        };
        let resolved = match crate::selector::resolve_via_smart(
            driver,
            action,
            &target,
            DEFAULT_ACTION_TIMEOUT_MS,
        )
        .await
        {
            Ok((sel, _)) => sel,
            Err(_) => continue,
        };
        if crate::auto_wait::wait_actionable(driver, &resolved, DEFAULT_ACTION_TIMEOUT_MS)
            .await
            .is_ok()
        {
            if persist {
                // Promote: swap primary with this fallback, old primary becomes fallbacks[0].
                let old_primary = step.primary.clone();
                step.fallbacks.remove(idx);
                step.fallbacks.insert(0, old_primary);
                step.primary = fallback;
                store.steps.insert(step_id, step);
                crate::targets_store::atomic_write(&targets_path, &store)?;
                tracing::info!(
                    target: "storycapture::automation::self_healing",
                    step_id = %step_id,
                    "primary selector missed; fallback promoted and targets.json rewritten"
                );
            }
            return Ok(Some(resolved));
        }
    }
    Ok(None)
}

async fn checkpoint(control: Option<&RunControl>) {
    if let Some(control) = control {
        control.checkpoint().await;
    }
}

async fn wait_with_pause(
    duration_ms: u64,
    control: Option<&RunControl>,
    driver: &dyn BrowserDriver,
) -> Result<()> {
    if control.is_none() {
        return driver.wait_ms(duration_ms).await;
    }

    let mut remaining_ms = duration_ms;
    while remaining_ms > 0 {
        checkpoint(control).await;
        let slice_ms = remaining_ms.min(PAUSE_POLL_SLICE_MS);
        driver.wait_ms(slice_ms).await?;
        remaining_ms -= slice_ms;
    }
    Ok(())
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

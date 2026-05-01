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
//! Events flow out through an `mpsc::Receiver<ExecutorEvent>` (actor
//! pattern). The optional `ProjectDb` writer persists session / step /
//! attempt rows.

use crate::action_timeline::{
    ActionPoint, ActionPointer, ActionTarget, ActionTimelineEvent, PointerButton,
};
use crate::capability::{driver_for, required_for};
use crate::control::RunControl;
use crate::driver::{ActionKind, BrowserDriver, LaunchConfig, LaunchOptions, ResolvedSelector};
use crate::error::{AutomationError, Result};
use crate::events::{AttemptLog, ExecutorEvent, MatchKind, StepFrame, StorySummary};
use crate::pacing::{PacingConfig, PacingProfile, PacingRuntime};
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

/// Behavior when the primary selector misses `wait_actionable`.
///
/// `self_heal: bool` previously had two incompatible meanings ("don't
/// persist" vs. "don't probe"); `HealPolicy` restores the distinction
/// without changing the public `self_heal: bool` surface.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum HealPolicy {
    /// Record path: short-circuit with
    /// [`AutomationError::PrimaryMissNoHeal`]; do NOT consult the targets
    /// sidecar. `.story.targets.json` is left byte-identical.
    RaiseOnMiss,
    /// Simulator read-only mode: probe fallbacks so the author sees
    /// `match_kind=Fuzzy`, but do NOT rewrite `.story.targets.json`.
    ProbeNoPersist,
    /// Simulator default / legacy: probe fallbacks and atomically promote the
    /// winner in `.story.targets.json`.
    ProbeAndPersist,
}

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
            /* self_heal */ true,
        )
    }

    fn run_with_story_path_policy(self_heal: bool) -> HealPolicy {
        if self_heal {
            HealPolicy::ProbeAndPersist
        } else {
            HealPolicy::RaiseOnMiss
        }
    }

    fn run_simulator_policy(self_heal: bool) -> HealPolicy {
        if self_heal {
            HealPolicy::ProbeAndPersist
        } else {
            HealPolicy::ProbeNoPersist
        }
    }

    /// Variant of [`Executor::run`] that threads a `.story` source path for
    /// the self-healing sidecar targets store. When `story_path` is `Some`,
    /// a command whose `meta.step_id` is set
    /// and whose primary selector fails `wait_actionable` will consult
    /// `<story_path>.targets.json`, iterate fallbacks, and atomically
    /// rewrite the sidecar on promotion. Passing `None` disables the
    /// self-healing hook (legacy callers / headless usage).
    ///
    /// `self_heal` is an explicit parameter. The recording path MUST pass
    /// `self_heal: false` — a primary-miss is raised as
    /// [`AutomationError::PrimaryMissNoHeal`] with no fallback probe and no
    /// mutation of `.story.targets.json`. `self_heal: true` preserves the
    /// legacy promote-on-miss behavior used by simulator runs that
    /// explicitly opt in to self-healing.
    #[allow(clippy::too_many_arguments)]
    pub fn run_with_story_path(
        story: Story,
        story_path: Option<PathBuf>,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
        control: Option<Arc<RunControl>>,
        self_heal: bool,
    ) -> mpsc::Receiver<ExecutorEvent> {
        Self::run_with_story_path_config(
            story,
            story_path,
            primary,
            fallback,
            persistence,
            screenshot_dir,
            launch_opts,
            control,
            self_heal,
            PacingConfig::raw(),
            false,
        )
    }

    /// Recording-mode runner with presentation pacing enabled by the caller.
    /// Existing executor entrypoints stay raw so simulator/dry-run behavior
    /// remains unchanged unless they explicitly opt in later.
    #[allow(clippy::too_many_arguments)]
    pub fn run_with_story_path_and_pacing(
        story: Story,
        story_path: Option<PathBuf>,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
        control: Option<Arc<RunControl>>,
        self_heal: bool,
        pacing: PacingProfile,
        collect_step_geometry: bool,
    ) -> mpsc::Receiver<ExecutorEvent> {
        Self::run_with_story_path_config(
            story,
            story_path,
            primary,
            fallback,
            persistence,
            screenshot_dir,
            launch_opts,
            control,
            self_heal,
            pacing.config(),
            collect_step_geometry,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn run_with_story_path_config(
        story: Story,
        story_path: Option<PathBuf>,
        primary: Box<dyn BrowserDriver>,
        fallback: Box<dyn BrowserDriver>,
        persistence: Option<PersistenceHandle>,
        screenshot_dir: PathBuf,
        launch_opts: LaunchOptions,
        control: Option<Arc<RunControl>>,
        self_heal: bool,
        pacing: PacingConfig,
        collect_step_geometry: bool,
    ) -> mpsc::Receiver<ExecutorEvent> {
        let (tx, rx) = mpsc::channel::<ExecutorEvent>(256);
        let heal_policy = Self::run_with_story_path_policy(self_heal);
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
                heal_policy,
                0,
                false,
                pacing,
                collect_step_geometry,
                tx,
            )
            .await;
        });
        rx
    }

    /// Simulator-mode runner — variant of `run_with_story_path`
    /// that threads four simulator params — `stop_after_ordinal`,
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
        let heal_policy = Self::run_simulator_policy(self_heal);
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
                heal_policy,
                0,
                false,
                PacingConfig::raw(),
                false,
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
    heal_policy: HealPolicy,
    start_after_ordinal: u32,
    already_launched: bool,
    pacing_config: PacingConfig,
    collect_step_geometry: bool,
    tx: mpsc::Sender<ExecutorEvent>,
) -> Result<()> {
    let started = Instant::now();
    let story_hash = hash_story(&story);
    if !already_launched {
        let _ = tx
            .send(ExecutorEvent::StoryStarted {
                story_hash: story_hash.clone(),
            })
            .await;
    }

    // Launch both drivers unless the caller supplied pre-launched ones
    // (simulator `continue_run`). Errors during launch are fatal for the
    // session — we can't dispatch anything without an open page.
    if !already_launched {
        let launch_cfg = LaunchConfig::from_meta(&story.meta, &launch_opts);
        primary.launch(launch_cfg.clone()).await?;
        fallback.launch(launch_cfg.clone()).await.ok(); // playwright sidecar may not be wired in unit tests
    }

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

    let mut pacing = PacingRuntime::new(pacing_config);
    let pacing_enabled = pacing.is_enabled();

    'scenes: for (i, scene) in story.scenes.iter().enumerate() {
        checkpoint(control.as_deref()).await;
        if is_cancelled(control.as_deref()) {
            break 'scenes;
        }
        let _ = tx
            .send(ExecutorEvent::SceneEntered {
                name: scene.name.clone(),
                ordinal: i as u32,
            })
            .await;
        for (cmd_index, cmd) in scene.commands.iter().enumerate() {
            checkpoint(control.as_deref()).await;
            if is_cancelled(control.as_deref()) {
                break 'scenes;
            }
            if pacing_enabled {
                let before_dwell_ms = pacing.before_command(i, cmd_index, cmd);
                if before_dwell_ms > 0 {
                    wait_with_pause(before_dwell_ms, control.as_deref(), primary.as_ref()).await?;
                }
            }
            ordinal += 1;
            total += 1;
            // continue_run fast-forward: skip commands the caller already
            // observed in a prior pause-ending run.
            if ordinal <= start_after_ordinal {
                continue;
            }
            let driver = Executor::pick_driver_for_cmd(primary.as_ref(), fallback.as_ref(), cmd);
            let driver_name = driver.name();
            let next_cmd = scene.commands.get(cmd_index + 1);

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
                heal_policy,
                pacing_config,
                started,
            )
            .await;

            match result {
                Ok(last_resolved) => {
                    if pacing_enabled {
                        let auto_dwell_ms = pacing.after_command(cmd, next_cmd);
                        if auto_dwell_ms > 0 {
                            wait_with_pause(auto_dwell_ms, control.as_deref(), driver).await?;
                        }
                    }
                    succeeded += 1;
                    let (cx, cy) = driver.current_cursor_position().await.unwrap_or((0, 0));
                    let duration_ms = cmd_started.elapsed().as_millis() as u64;
                    let (matched_selector, matched_bbox, match_kind) = match last_resolved.as_ref()
                    {
                        Some((rs, kind)) => {
                            let bbox = if collect_step_geometry || capture_frames {
                                driver.element_state(rs).await.ok().and_then(|s| s.bbox)
                            } else {
                                None
                            };
                            (Some(rs.value.clone()), bbox, *kind)
                        }
                        None => (None, None, MatchKind::None),
                    };
                    let _ = tx
                        .send(ExecutorEvent::StepSucceeded {
                            ordinal,
                            step_id: cmd.step_id(),
                            duration_ms,
                            cursor_x: cx,
                            cursor_y: cy,
                            matched_selector: matched_selector.clone(),
                            matched_bbox,
                            match_kind,
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
                    // Stop on first failure.
                    break 'scenes;
                }
            }
        }
        pacing.finish_scene();
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
    heal_policy: HealPolicy,
    pacing: PacingConfig,
    run_started: Instant,
) -> std::result::Result<Option<(ResolvedSelector, MatchKind)>, (AutomationError, Vec<AttemptLog>)>
{
    let mut attempts: Vec<AttemptLog> = Vec::new();
    let mut last_resolved: Option<(ResolvedSelector, MatchKind)> = None;
    checkpoint(control).await;

    // Step_id from the DSL line itself (`# @id=<uuidv7>`), used
    // by the self-healing path to key into the targets sidecar. Distinct
    // from the `step_id` param, which is the storage row id.
    let cmd_step_id = cmd.step_id();

    macro_rules! resolve {
        ($target:expr, $target_nth:expr, $action:expr) => {{
            match crate::selector::resolve_via_smart(
                driver,
                $action,
                $target,
                $target_nth,
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

    // Wait-actionable with self-healing fallback promotion.
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
                    // Record-path and read-only simulator semantics are
                    // split via `HealPolicy`:
                    //
                    // - `RaiseOnMiss` (record path): short-circuit with
                    //   `PrimaryMissNoHeal`; never consult the sidecar.
                    // - `ProbeNoPersist` (simulator read-only): probe
                    //   fallbacks so the author sees `match_kind=Fuzzy`,
                    //   but leave `.story.targets.json` byte-identical.
                    // - `ProbeAndPersist` (simulator/legacy): probe and
                    //   atomically rewrite the sidecar on promotion.
                    match heal_policy {
                        HealPolicy::RaiseOnMiss => {
                            return Err((
                                AutomationError::PrimaryMissNoHeal {
                                    step_ordinal: ordinal,
                                    step_id: cmd_step_id,
                                    verb: format_verb_excerpt(cmd),
                                },
                                attempts,
                            ));
                        }
                        HealPolicy::ProbeNoPersist | HealPolicy::ProbeAndPersist => {
                            let persist = matches!(heal_policy, HealPolicy::ProbeAndPersist);
                            match try_promote_fallback(
                                driver,
                                cmd_step_id,
                                story_path,
                                $action,
                                persist,
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
                }
            }
        }};
    }

    let result = match cmd {
        Command::Navigate { url, .. } => driver.goto(url).await,
        Command::Click {
            target, target_nth, ..
        } => {
            let sel = resolve!(target, *target_nth, ActionKind::Click);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Click);
            let target_box = action_target(driver, &sel, Some(target_label(target))).await;
            wait_with_pause(pacing.clamp_dwell(pacing.before_click_ms), control, driver)
                .await
                .map_err(|e| (e, attempts.clone()))?;
            let t_action_ms = timeline_ms(run_started);
            let action_result = driver.click(&sel).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "click",
                    t_start_ms: t_action_ms,
                    t_action_ms,
                    target: target_box,
                    secondary_target: None,
                    pointer: Some(click_pointer()),
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Type {
            target,
            target_nth,
            text,
            ..
        } => {
            let sel = resolve!(target, *target_nth, ActionKind::Type);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Type);
            let target_box = action_target(driver, &sel, Some(target_label(target))).await;
            let t_start_ms = timeline_ms(run_started);
            let action_result = driver.type_text(&sel, text).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "type",
                    t_start_ms,
                    t_action_ms: t_start_ms,
                    target: target_box,
                    secondary_target: None,
                    pointer: None,
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Scroll {
            direction, amount, ..
        } => driver.scroll(*direction, *amount).await,
        Command::Hover {
            target, target_nth, ..
        } => {
            let sel = resolve!(target, *target_nth, ActionKind::Hover);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Hover);
            let target_box = action_target(driver, &sel, Some(target_label(target))).await;
            let t_start_ms = timeline_ms(run_started);
            let action_result = driver.hover(&sel).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "hover",
                    t_start_ms,
                    t_action_ms: t_start_ms,
                    target: target_box,
                    secondary_target: None,
                    pointer: None,
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Drag {
            from,
            from_nth,
            to,
            to_nth,
            ..
        } => {
            let sf = resolve!(from, *from_nth, ActionKind::Drag);
            let st = resolve!(to, *to_nth, ActionKind::Drag);
            // Self-healing for drag targets: only the FROM is healed; the
            // TO side is a drop target whose identity is paired with the
            // source, so mutating it in isolation is unsafe.
            let sf = wait_actionable_or_heal!(sf, ActionKind::Drag);
            if let Err(e) =
                crate::auto_wait::wait_actionable(driver, &st, DEFAULT_ACTION_TIMEOUT_MS).await
            {
                return Err((e, attempts));
            }
            let from_box = action_target(driver, &sf, Some(target_label(from))).await;
            let to_box = action_target(driver, &st, Some(target_label(to))).await;
            let t_start_ms = timeline_ms(run_started);
            let action_result = driver.drag(&sf, &st).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "drag",
                    t_start_ms,
                    t_action_ms: t_start_ms,
                    target: from_box,
                    secondary_target: to_box,
                    pointer: None,
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Select {
            target,
            target_nth,
            value,
            ..
        } => {
            let sel = resolve!(target, *target_nth, ActionKind::Select);
            let sel = wait_actionable_or_heal!(sel, ActionKind::Select);
            let target_box = action_target(driver, &sel, Some(target_label(target))).await;
            let t_start_ms = timeline_ms(run_started);
            let action_result = driver.select_option(&sel, value).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "select",
                    t_start_ms,
                    t_action_ms: t_start_ms,
                    target: target_box,
                    secondary_target: None,
                    pointer: None,
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Upload {
            target,
            target_nth,
            path,
            ..
        } => {
            let sel = resolve!(target, *target_nth, ActionKind::Upload);
            let target_box = action_target(driver, &sel, Some(target_label(target))).await;
            let t_start_ms = timeline_ms(run_started);
            let action_result = driver.upload_file(&sel, std::path::Path::new(path)).await;
            emit_successful_action(
                tx,
                &action_result,
                ActionEventDraft {
                    step_id: cmd_step_id,
                    ordinal,
                    verb: "upload",
                    t_start_ms,
                    t_action_ms: t_start_ms,
                    target: target_box,
                    secondary_target: None,
                    pointer: None,
                },
                run_started,
            )
            .await;
            action_result
        }
        Command::Wait { duration_ms, .. } => wait_with_pause(*duration_ms, control, driver).await,
        Command::WaitFor {
            target,
            target_nth,
            timeout_ms,
            ..
        } => {
            driver
                .wait_for(
                    target,
                    *target_nth,
                    timeout_ms.unwrap_or(DEFAULT_WAITFOR_TIMEOUT_MS),
                )
                .await
        }
        Command::Assert {
            target, target_nth, ..
        } => driver.assert_present(target, *target_nth).await,
        Command::Screenshot { name, .. } => {
            driver.screenshot(name, screenshot_dir).await.map(|_| ())
        }
        Command::Pause { .. } => Ok(()),
    };

    result.map(|()| last_resolved).map_err(|e| (e, attempts))
}

/// Resume a simulator session with an already-launched driver pair.
///
/// Unlike [`Executor::run_simulator`], this does NOT call
/// `primary.launch()` / `fallback.launch()` — the caller passes the same
/// drivers returned from a previous run that terminated with `RunPaused`.
/// The caller is responsible for tracking `start_after_ordinal` so already-
/// executed steps are skipped silently (no events emitted for them).
#[allow(clippy::too_many_arguments)]
pub async fn continue_run(
    story: Story,
    story_path: Option<PathBuf>,
    primary: Box<dyn BrowserDriver>,
    fallback: Box<dyn BrowserDriver>,
    persistence: Option<PersistenceHandle>,
    screenshot_dir: PathBuf,
    control: Option<Arc<RunControl>>,
    start_after_ordinal: u32,
    stop_after_ordinal: Option<u32>,
    capture_frames: bool,
    frame_dir: Option<PathBuf>,
    self_heal: bool,
    tx: mpsc::Sender<ExecutorEvent>,
) -> Result<()> {
    // `continue_run` resumes a simulator session — map `self_heal` with the
    // same policy as `run_simulator` (read-only Fuzzy probing when false).
    let heal_policy = Executor::run_simulator_policy(self_heal);
    run_story(
        story,
        story_path,
        primary,
        fallback,
        persistence,
        screenshot_dir,
        LaunchOptions::default(),
        control,
        stop_after_ordinal,
        capture_frames,
        frame_dir,
        heal_policy,
        start_after_ordinal,
        true,
        PacingConfig::raw(),
        capture_frames,
        tx,
    )
    .await
}

/// Self-healing hook. On a primary `wait_actionable` miss,
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
        // Self-healing fallback: propagate the fallback record's nth.
        // Pre-Fix-#4 stamps land here as `None`, preserving legacy behavior.
        let resolved = match crate::selector::resolve_via_smart(
            driver,
            action,
            &target,
            fallback.nth,
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

/// Render a short `verb + target` excerpt for error messages —
/// e.g. `click "Save"`, `type "Email"`, `navigate https://…`.
///
/// Used by [`AutomationError::PrimaryMissNoHeal`] so the HUD can surface
/// the locked copy (`Step {N}: "{verb}" could not match any element.`)
/// without the UI layer re-parsing the command.
fn format_verb_excerpt(cmd: &Command) -> String {
    fn target_text(t: &story_parser::SelectorOrText) -> String {
        match t {
            story_parser::SelectorOrText::Text(s)
            | story_parser::SelectorOrText::Selector(s)
            | story_parser::SelectorOrText::TestId(s)
            | story_parser::SelectorOrText::Aria(s)
            | story_parser::SelectorOrText::Label(s)
            | story_parser::SelectorOrText::TextExact(s) => format!("\"{s}\""),
            story_parser::SelectorOrText::Role { name, .. } => format!("\"{name}\""),
        }
    }
    let verb = cmd.verb();
    match cmd {
        Command::Click { target, .. }
        | Command::Type { target, .. }
        | Command::Hover { target, .. }
        | Command::Select { target, .. }
        | Command::Upload { target, .. } => format!("{verb} {}", target_text(target)),
        Command::WaitFor { target, .. } | Command::Assert { target, .. } => {
            format!("{verb} {}", target_text(target))
        }
        Command::Drag { from, .. } => format!("{verb} {}", target_text(from)),
        Command::Navigate { url, .. } => format!("{verb} {url}"),
        Command::Scroll { direction, .. } => format!("{verb} {direction:?}"),
        Command::Screenshot { name, .. } => format!("{verb} \"{name}\""),
        Command::Wait { duration_ms, .. } => format!("{verb} {duration_ms}ms"),
        Command::Pause { .. } => verb.to_string(),
    }
}

fn is_cancelled(control: Option<&RunControl>) -> bool {
    control.map(|c| c.is_cancelled()).unwrap_or(false)
}

fn timeline_ms(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

struct ActionEventDraft {
    step_id: Option<uuid::Uuid>,
    ordinal: u32,
    verb: &'static str,
    t_start_ms: u64,
    t_action_ms: u64,
    target: Option<ActionTarget>,
    secondary_target: Option<ActionTarget>,
    pointer: Option<ActionPointer>,
}

async fn emit_successful_action(
    tx: &mpsc::Sender<ExecutorEvent>,
    action_result: &Result<()>,
    draft: ActionEventDraft,
    run_started: Instant,
) {
    if action_result.is_err() {
        return;
    }
    emit_action(
        tx,
        ActionTimelineEvent {
            step_id: draft.step_id.map(|id| id.to_string()),
            ordinal: draft.ordinal,
            verb: draft.verb.into(),
            t_start_ms: draft.t_start_ms,
            t_action_ms: draft.t_action_ms,
            t_end_ms: timeline_ms(run_started),
            target: draft.target,
            secondary_target: draft.secondary_target,
            pointer: draft.pointer,
        },
    )
    .await;
}

fn click_pointer() -> ActionPointer {
    ActionPointer {
        button: PointerButton::Left,
        effect: "click".into(),
    }
}

async fn emit_action(tx: &mpsc::Sender<ExecutorEvent>, event: ActionTimelineEvent) {
    let _ = tx.send(ExecutorEvent::ActionRecorded { event }).await;
}

async fn action_target(
    driver: &dyn BrowserDriver,
    sel: &ResolvedSelector,
    label: Option<String>,
) -> Option<ActionTarget> {
    let state = driver.element_state(sel).await.ok()?;
    let bounds = state.bbox?;
    Some(ActionTarget {
        kind: "element".into(),
        label,
        center: ActionPoint {
            x: bounds.x + bounds.w / 2.0,
            y: bounds.y + bounds.h / 2.0,
        },
        bounds,
    })
}

fn target_label(target: &story_parser::SelectorOrText) -> String {
    match target {
        story_parser::SelectorOrText::Text(s)
        | story_parser::SelectorOrText::Selector(s)
        | story_parser::SelectorOrText::TestId(s)
        | story_parser::SelectorOrText::Aria(s)
        | story_parser::SelectorOrText::Label(s)
        | story_parser::SelectorOrText::TextExact(s) => s.clone(),
        story_parser::SelectorOrText::Role { name, .. } => name.clone(),
    }
}

async fn wait_with_pause(
    duration_ms: u64,
    control: Option<&RunControl>,
    driver: &dyn BrowserDriver,
) -> Result<()> {
    if duration_ms == 0 {
        return Ok(());
    }
    if control.is_none() {
        return driver.wait_ms(duration_ms).await;
    }

    let mut remaining_ms = duration_ms;
    while remaining_ms > 0 {
        checkpoint(control).await;
        if is_cancelled(control) {
            return Ok(());
        }
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

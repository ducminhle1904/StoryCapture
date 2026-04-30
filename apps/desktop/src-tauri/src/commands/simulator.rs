//! Author-time simulator — Tauri command surface over `automation::continue_run`.
//!
//! Every simulator run reuses the already-launched author-preview Playwright
//! context. All invocations go through `continue_run` (which never calls
//! `launch()`) so no second Chromium is spawned — the `start_after_ordinal=0`
//! first call behaves as "run from the beginning" without relaunching.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use automation::{ExecutorEvent, MatchKind, RunControl, StepFrame};

use crate::author_driver::{AuthorDriverRegistry, AuthorDriverState};
use crate::commands::automation_shared::SharedAuthorDriver;
use crate::error::AppError;
use crate::state::AppState;

pub type SimulatorSessionId = String;

/// Resumable run state held between `simulator_step_to` calls.
///
/// We never hand boxed drivers back out of the executor task — instead we
/// keep the author-session's `Arc<PlaywrightSidecarDriver>` here and wrap
/// it in a fresh `SharedPlaywrightDriver` for every `continue_run`
/// invocation. Cheap (one Arc clone); launch() is never called.
pub struct ResumableSession {
    pub stream_id: String,
    pub project_folder: PathBuf,
    pub story_path: PathBuf,
    pub story_source: String,
    /// Parsed AST — shared across step_to/promote to avoid re-parsing.
    pub story: Arc<story_parser::Story>,
    pub run_id: String,
    pub frame_dir: PathBuf,
    pub total_steps: u32,
    pub last_ordinal: Arc<std::sync::atomic::AtomicU32>,
    pub control: Arc<RunControl>,
    pub task: Option<JoinHandle<()>>,
    /// Per-ordinal frame snapshot. Promote-to-fallback reads this to find
    /// the matched selector for the target ordinal.
    pub frames: Arc<Mutex<HashMap<u32, StepFrame>>>,
    pub channel: Channel<SimulatorEvent>,
    /// Shared author-session driver (Arc-cloned from AuthorPreviewSession).
    pub driver: Arc<automation::PlaywrightSidecarDriver>,
    /// Snapshot of the AuthorDriverState captured at `begin_simulator` time.
    /// Used by `simulator_cancel` to restore the registry via
    /// `end_simulator(prior)`. The forwarder's `StoryEnded` arm captures the
    /// same snapshot via closure, so a cancel/StoryEnded race is safe
    /// (end_simulator is a no-op when state is not Simulator*).
    pub prior_author_driver_state: AuthorDriverState,
}

#[derive(Default)]
pub struct SimulatorRegistry {
    pub sessions: Arc<Mutex<HashMap<SimulatorSessionId, ResumableSession>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimulatorEvent {
    Started {
        session_id: String,
        run_id: String,
        total_steps: u32,
    },
    StepStarted {
        ordinal: u32,
    },
    FrameCaptured {
        ordinal: u32,
        frame: SimulatorStepFrame,
    },
    Paused {
        ordinal: u32,
    },
    Failed {
        ordinal: u32,
        error_message: String,
    },
    Completed {
        succeeded: u32,
        failed: u32,
    },
    Cancelled,
}

/// specta-friendly mirror of `automation::StepFrame` for renderer IPC.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SimulatorStepFrame {
    pub ordinal: u32,
    pub screenshot_path: Option<String>,
    pub cursor_xy: (i32, i32),
    pub matched_selector: Option<String>,
    pub matched_bbox: Option<SimulatorBbox>,
    pub match_kind: SimulatorMatchKind,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SimulatorBbox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SimulatorMatchKind {
    Primary,
    Fuzzy,
    None,
}

impl From<&StepFrame> for SimulatorStepFrame {
    fn from(f: &StepFrame) -> Self {
        SimulatorStepFrame {
            ordinal: f.ordinal,
            screenshot_path: f
                .screenshot_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            cursor_xy: f.cursor_xy,
            matched_selector: f.matched_selector.clone(),
            matched_bbox: f.matched_bbox.as_ref().map(|b| SimulatorBbox {
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
            }),
            match_kind: match f.match_kind {
                MatchKind::Primary => SimulatorMatchKind::Primary,
                MatchKind::Fuzzy => SimulatorMatchKind::Fuzzy,
                MatchKind::None => SimulatorMatchKind::None,
            },
            duration_ms: f.duration_ms,
        }
    }
}

/// Retention trim — keep the 5 most recent run dirs under
/// `<project_folder>/.story.simulator/`. Returns number of dirs deleted.
pub fn prune_runs_retain_5(project_folder: &Path) -> std::io::Result<usize> {
    let root = project_folder.join(".story.simulator");
    if !root.exists() {
        std::fs::create_dir_all(&root)?;
        return Ok(0);
    }
    let mut entries: Vec<(PathBuf, SystemTime)> = std::fs::read_dir(&root)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let mtime = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((e.path(), mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    let mut deleted = 0;
    for (path, _) in entries.into_iter().skip(5) {
        let _ = std::fs::remove_dir_all(&path);
        deleted += 1;
    }
    Ok(deleted)
}

fn count_total_steps(story: &story_parser::Story) -> u32 {
    story
        .scenes
        .iter()
        .map(|s| s.commands.len() as u32)
        .sum::<u32>()
}

/// Spawn the executor + event forwarder. Used by both first-run and resume
/// paths. The shared driver is never relaunched — all runs use `continue_run`.
///
/// `author_registry` lets the forwarder write `SimulatorPaused` on
/// `ExecutorEvent::RunPaused` and restore the prior state on
/// `ExecutorEvent::StoryEnded`. `prior_state_for_restore` is `Some` on the
/// initial `simulator_start` spawn (forwarder owns the StoryEnded restore)
/// and `None` on `simulator_step_to` re-spawns (the original
/// simulator_start's forwarder already handled its restore before being
/// aborted; on re-run StoryEnded, `simulator_cancel` /
/// ResumableSession.prior_author_driver_state is the authoritative
/// restore path).
#[allow(clippy::too_many_arguments)]
async fn spawn_run(
    session_id: String,
    story: story_parser::Story,
    story_path: PathBuf,
    frame_dir: PathBuf,
    screenshot_dir: PathBuf,
    driver: Arc<automation::PlaywrightSidecarDriver>,
    control: Arc<RunControl>,
    start_after_ordinal: u32,
    stop_after_ordinal: Option<u32>,
    channel: Channel<SimulatorEvent>,
    frames: Arc<Mutex<HashMap<u32, StepFrame>>>,
    last_ordinal: Arc<std::sync::atomic::AtomicU32>,
    emit_started: Option<(String, u32)>,
    sessions: Arc<Mutex<HashMap<SimulatorSessionId, ResumableSession>>>,
    author_registry: Arc<AuthorDriverRegistry>,
    prior_state_for_restore: Option<AuthorDriverState>,
) -> JoinHandle<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ExecutorEvent>(256);
    let primary: Box<dyn automation::BrowserDriver> =
        Box::new(SharedAuthorDriver::new(driver.clone()));
    let fallback: Box<dyn automation::BrowserDriver> = Box::new(automation::NoopDriver::new());

    let story_path_for_exec = Some(story_path);
    tokio::spawn(async move {
        tracing::info!(
            target: "storycapture::simulator",
            start_after_ordinal,
            ?stop_after_ordinal,
            "executor task starting"
        );
        match automation::continue_run(
            story,
            story_path_for_exec,
            primary,
            fallback,
            None,
            screenshot_dir,
            Some(control),
            start_after_ordinal,
            stop_after_ordinal,
            true,
            Some(frame_dir),
            false,
            tx,
        )
        .await
        {
            Ok(_) => tracing::info!(
                target: "storycapture::simulator",
                "executor task completed Ok"
            ),
            Err(e) => tracing::error!(
                target: "storycapture::simulator",
                error = ?e,
                "executor task returned Err"
            ),
        }
    });

    tokio::spawn(async move {
        if let Some((run_id, total_steps)) = emit_started {
            let _ = channel.send(SimulatorEvent::Started {
                session_id: session_id.clone(),
                run_id,
                total_steps,
            });
        }
        while let Some(ev) = rx.recv().await {
            let variant_tag = match &ev {
                ExecutorEvent::StepStarted { ordinal, .. } => {
                    format!("StepStarted ord={}", ordinal)
                }
                ExecutorEvent::StepFrameCaptured { ordinal, .. } => {
                    format!("StepFrameCaptured ord={}", ordinal)
                }
                ExecutorEvent::StepSucceeded { ordinal, .. } => {
                    format!("StepSucceeded ord={}", ordinal)
                }
                ExecutorEvent::RunPaused { ordinal } => format!("RunPaused ord={}", ordinal),
                ExecutorEvent::StepFailed {
                    ordinal,
                    error_message,
                    ..
                } => format!("StepFailed ord={} err={}", ordinal, error_message),
                ExecutorEvent::StoryEnded { status } => format!(
                    "StoryEnded succeeded={} failed={}",
                    status.succeeded, status.failed
                ),
                _ => "other".to_string(),
            };
            tracing::info!(target: "storycapture::simulator", event = %variant_tag, "forwarder rx event");
            match ev {
                ExecutorEvent::StepStarted { ordinal, .. } => {
                    let _ = channel.send(SimulatorEvent::StepStarted { ordinal });
                }
                ExecutorEvent::StepFrameCaptured { ordinal, frame } => {
                    {
                        let mut g = frames.lock().await;
                        g.insert(ordinal, frame.clone());
                    }
                    let _ = channel.send(SimulatorEvent::FrameCaptured {
                        ordinal,
                        frame: SimulatorStepFrame::from(&frame),
                    });
                }
                ExecutorEvent::StepSucceeded { ordinal, .. } => {
                    last_ordinal.store(ordinal, std::sync::atomic::Ordering::SeqCst);
                }
                ExecutorEvent::RunPaused { ordinal } => {
                    last_ordinal.store(ordinal, std::sync::atomic::Ordering::SeqCst);
                    // Flip SimulatorRunning -> SimulatorPaused under the
                    // registry lock. pause_simulator is a no-op if the state
                    // isn't SimulatorRunning, so a late RunPaused arriving
                    // after simulator_cancel is harmless.
                    {
                        let mut g = author_registry.state.lock().await;
                        g.pause_simulator();
                    }
                    let _ = channel.send(SimulatorEvent::Paused { ordinal });
                }
                ExecutorEvent::StepFailed {
                    ordinal,
                    error_message,
                    ..
                } => {
                    let _ = channel.send(SimulatorEvent::Failed {
                        ordinal,
                        error_message,
                    });
                }
                ExecutorEvent::StoryEnded { status } => {
                    let _ = channel.send(SimulatorEvent::Completed {
                        succeeded: status.succeeded,
                        failed: status.failed,
                    });
                    // StoryEnded is the natural exit. If simulator_cancel
                    // already ran end_simulator, the second call is a no-op
                    // (end_simulator guards against non-Simulator* state).
                    // Only the initial simulator_start spawn carries a
                    // restore snapshot; step_to re-spawns pass None and let
                    // simulator_cancel own the restore.
                    if let Some(prior) = prior_state_for_restore.as_ref() {
                        let mut g = author_registry.state.lock().await;
                        g.end_simulator(prior.clone());
                    }
                    // Resume the CDP screencast that simulator_start paused
                    // for exclusive CDP use. Without this, Live Preview
                    // stays black after a natural run end (success or
                    // failure) until the user toggles Preview off/on.
                    // simulator_cancel does this on its own teardown path.
                    let cleanup = {
                        let g = sessions.lock().await;
                        g.get(&session_id)
                            .map(|s| (s.driver.clone(), s.stream_id.clone()))
                    };
                    if let Some((d, sid)) = cleanup {
                        let _ = d.call_resume_stream(&sid).await;
                        let _ = d.set_active_author_stream(None).await;
                    }
                    sessions.lock().await.remove(&session_id);
                    break;
                }
                _ => {}
            }
        }
        tracing::info!(
            target: "storycapture::simulator",
            "forwarder rx closed — loop exiting"
        );
    })
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "simulator_start"), err(Debug))]
pub async fn simulator_start(
    state: State<'_, AppState>,
    registry: State<'_, SimulatorRegistry>,
    author_registry: State<'_, Arc<AuthorDriverRegistry>>,
    project_folder: String,
    story_source: String,
    story_path: String,
    stream_id: String,
    stop_after_ordinal: Option<u32>,
    channel: Channel<SimulatorEvent>,
) -> Result<String, AppError> {
    tracing::info!(
        target: "storycapture::simulator",
        stream_id = %stream_id,
        project_folder = %project_folder,
        "simulator_start request received"
    );
    // Host-layer gate against active Pick. MUST run BEFORE any side effect
    // (driver probe, prune, Chromium pause). Allocate the session_id here
    // so we can pass it to begin_simulator and snapshot the prior
    // AuthorDriverState under the same lock scope.
    let session_id = Uuid::new_v4().to_string();
    let author_registry_arc = author_registry.inner().clone();
    let prior_state_for_restore = {
        let mut g = author_registry_arc.state.lock().await;
        g.can_start_simulator()
            .map_err(|e| AppError::Automation(e.to_string()))?;
        g.begin_simulator(session_id.clone())
    };
    tracing::info!(
        target: "storycapture::simulator",
        session_id = %session_id,
        "begin_simulator FSM transition OK"
    );

    // Any Err after begin_simulator must restore the FSM before returning.
    // The inner fn keeps the fallible body in one ?-friendly block; the
    // outer match restores on Err.
    match simulator_start_inner(
        state,
        registry,
        author_registry_arc.clone(),
        prior_state_for_restore.clone(),
        session_id.clone(),
        project_folder,
        story_source,
        story_path,
        stream_id,
        stop_after_ordinal,
        channel,
    )
    .await
    {
        Ok(sid) => Ok(sid),
        Err(e) => {
            // Restore FSM on any early-failure path before returning Err.
            let mut g = author_registry_arc.state.lock().await;
            g.end_simulator(prior_state_for_restore);
            Err(e)
        }
    }
}

/// Inner body of `simulator_start`. Extracted so that `simulator_start`
/// can restore the `AuthorDriverRegistry` via `end_simulator(prior)` on
/// any `?`-propagated error in this block. The happy-path `Ok(session_id)`
/// does NOT restore — the forwarder's `StoryEnded` arm and
/// `simulator_cancel` together own the post-success restore.
#[allow(clippy::too_many_arguments)]
async fn simulator_start_inner(
    state: State<'_, AppState>,
    registry: State<'_, SimulatorRegistry>,
    author_registry: Arc<AuthorDriverRegistry>,
    prior_state_for_restore: AuthorDriverState,
    session_id: String,
    project_folder: String,
    story_source: String,
    story_path: String,
    stream_id: String,
    stop_after_ordinal: Option<u32>,
    channel: Channel<SimulatorEvent>,
) -> Result<String, AppError> {
    let parse = story_parser::parse(&story_source);
    let story_ast = parse
        .ast
        .ok_or_else(|| AppError::InvalidArgument("story parse failed".into()))?;
    let total_steps = count_total_steps(&story_ast);
    let story = Arc::new(story_ast);

    if let Some(ord) = stop_after_ordinal {
        if ord == 0 || ord > total_steps {
            return Err(AppError::InvalidArgument(format!(
                "ordinal {ord} out of range (story has {total_steps} steps)"
            )));
        }
    }

    // Author-preview must be running; we never silently spawn a second Chromium.
    let driver_arc = {
        let sessions = state.author_preview_sessions.lock().await;
        sessions
            .get(&stream_id)
            .map(|s| s.driver.clone())
            .ok_or_else(|| {
                AppError::UnavailableOnBackend(
                    "preview is disabled — enable Preview in the Editor header before running the simulator".into(),
                )
            })?
    };
    tracing::info!(target: "storycapture::simulator", "author driver resolved");
    driver_arc
        .set_active_author_stream(Some(&stream_id))
        .await
        .map_err(|e| AppError::Automation(format!("set_active_author_stream: {e}")))?;
    tracing::info!(target: "storycapture::simulator", "active author stream set");

    // Readiness probe + pause the author screencast for exclusive CDP use,
    // in parallel with the blocking filesystem retention trim.
    let project_path = PathBuf::from(&project_folder);
    let prune_path = project_path.clone();
    let prune_task = tokio::task::spawn_blocking(move || prune_runs_retain_5(&prune_path));

    {
        driver_arc
            .pick_element_is_active()
            .await
            .map_err(|e| AppError::Automation(format!("attach_author_driver probe: {e}")))?;
        tracing::info!(target: "storycapture::simulator", "readiness probe OK");
        tracing::info!(target: "storycapture::simulator", "pausing CDP screencast");
        driver_arc
            .call_pause_stream(&stream_id)
            .await
            .map_err(|e| AppError::Automation(e.to_string()))?;
        tracing::info!(target: "storycapture::simulator", "CDP screencast paused");
    }

    prune_task
        .await
        .map_err(|e| AppError::Io(format!("prune task join: {e}")))?
        .map_err(|e| AppError::Io(format!("prune simulator runs: {e}")))?;

    let run_id = Uuid::new_v4().to_string();
    let frame_dir = project_path.join(".story.simulator").join(&run_id);
    std::fs::create_dir_all(&frame_dir).map_err(AppError::from)?;
    let screenshot_dir = frame_dir.clone();

    let story_path_buf = PathBuf::from(&story_path);
    let control = Arc::new(RunControl::new());
    let frames = Arc::new(Mutex::new(HashMap::<u32, StepFrame>::new()));
    let last_ordinal = Arc::new(std::sync::atomic::AtomicU32::new(0));

    tracing::info!(
        target: "storycapture::simulator",
        run_id = %run_id,
        total_steps,
        "spawning executor + forwarder"
    );
    let forwarder = spawn_run(
        session_id.clone(),
        (*story).clone(),
        story_path_buf.clone(),
        frame_dir.clone(),
        screenshot_dir,
        driver_arc.clone(),
        control.clone(),
        0,
        stop_after_ordinal,
        channel.clone(),
        frames.clone(),
        last_ordinal.clone(),
        Some((run_id.clone(), total_steps)),
        registry.sessions.clone(),
        author_registry.clone(),
        Some(prior_state_for_restore.clone()),
    )
    .await;

    let mut sessions = registry.sessions.lock().await;
    sessions.insert(
        session_id.clone(),
        ResumableSession {
            stream_id,
            project_folder: project_path,
            story_path: story_path_buf,
            story_source,
            story,
            run_id,
            frame_dir,
            total_steps,
            last_ordinal,
            control,
            task: Some(forwarder),
            frames,
            channel,
            driver: driver_arc,
            prior_author_driver_state: prior_state_for_restore,
        },
    );
    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "simulator_step_to"),
    err(Debug)
)]
pub async fn simulator_step_to(
    registry: State<'_, SimulatorRegistry>,
    author_registry: State<'_, Arc<AuthorDriverRegistry>>,
    session_id: String,
    ordinal: u32,
) -> Result<(), AppError> {
    let mut sessions = registry.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("simulator session {session_id} not found")))?;

    if ordinal == 0 || ordinal > session.total_steps {
        return Err(AppError::InvalidArgument(format!(
            "ordinal {ordinal} out of range (story has {} steps)",
            session.total_steps
        )));
    }
    let last = session
        .last_ordinal
        .load(std::sync::atomic::Ordering::SeqCst);
    if ordinal <= last {
        return Err(AppError::InvalidArgument(format!(
            "ordinal {ordinal} already executed (last={last})"
        )));
    }

    // Drain the prior forwarder task if still holding a handle. The prior
    // executor has already returned (we reached here because RunPaused
    // fired), so awaiting is a no-op tick.
    if let Some(task) = session.task.take() {
        task.abort();
    }

    // step_to does NOT mutate AuthorDriverState (a SimulatorRunning ->
    // SimulatorRunning transition inside an already active session is a
    // no-op). We still pass the registry through so the re-spawned
    // forwarder can writeback SimulatorPaused on the next RunPaused, but
    // we pass `None` as the restore snapshot — simulator_cancel /
    // ResumableSession.prior_author_driver_state is the authoritative
    // restore path for step_to re-runs.
    let forwarder = spawn_run(
        session_id.clone(),
        (*session.story).clone(),
        session.story_path.clone(),
        session.frame_dir.clone(),
        session.frame_dir.clone(),
        session.driver.clone(),
        session.control.clone(),
        last,
        Some(ordinal),
        session.channel.clone(),
        session.frames.clone(),
        session.last_ordinal.clone(),
        None,
        registry.sessions.clone(),
        author_registry.inner().clone(),
        None,
    )
    .await;
    session.task = Some(forwarder);
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "simulator_cancel"), err(Debug))]
pub async fn simulator_cancel(
    state: State<'_, AppState>,
    registry: State<'_, SimulatorRegistry>,
    author_registry: State<'_, Arc<AuthorDriverRegistry>>,
    session_id: String,
) -> Result<(), AppError> {
    let session_opt = {
        let mut sessions = registry.sessions.lock().await;
        sessions.remove(&session_id)
    };
    let Some(mut session) = session_opt else {
        return Err(AppError::NotFound(format!(
            "simulator session {session_id} not found"
        )));
    };
    session.control.cancel();
    if let Some(task) = session.task.take() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
    }
    {
        let sessions = state.author_preview_sessions.lock().await;
        if let Some(s) = sessions.get(&session.stream_id) {
            let _ = s.driver.call_resume_stream(&session.stream_id).await;
        }
    }
    let _ = session.driver.set_active_author_stream(None).await;
    // Restore AuthorDriverState from the snapshot captured by
    // simulator_start's begin_simulator. The forwarder's StoryEnded arm
    // may also fire end_simulator on the same cancel-induced executor
    // exit — end_simulator is a no-op when state is not Simulator*, so
    // double-calls are safe.
    {
        let mut g = author_registry.state.lock().await;
        g.end_simulator(std::mem::take(&mut session.prior_author_driver_state));
    }
    let _ = session.channel.send(SimulatorEvent::Cancelled);
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "simulator_promote_fallback"),
    err(Debug)
)]
pub async fn simulator_promote_fallback(
    registry: State<'_, SimulatorRegistry>,
    session_id: String,
    ordinal: u32,
) -> Result<(), AppError> {
    let sessions = registry.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("simulator session {session_id} not found")))?;

    let frame = {
        let frames = session.frames.lock().await;
        frames.get(&ordinal).cloned()
    };
    let frame = frame.ok_or_else(|| {
        AppError::InvalidArgument(format!("no captured frame for ordinal {ordinal}"))
    })?;
    if !matches!(frame.match_kind, MatchKind::Fuzzy) {
        return Err(AppError::InvalidArgument(
            "promote-to-fallback is only valid on fuzzy matches".into(),
        ));
    }

    // Locate the command at `ordinal` in the parsed story to extract its
    // step_id + ActionKind.
    let story = &session.story;
    let mut running: u32 = 0;
    let mut located: Option<&story_parser::Command> = None;
    'outer: for scene in &story.scenes {
        for cmd in &scene.commands {
            running += 1;
            if running == ordinal {
                located = Some(cmd);
                break 'outer;
            }
        }
    }
    let cmd = located
        .ok_or_else(|| AppError::NotFound(format!("command at ordinal {ordinal} not found")))?;
    let step_id = cmd.step_id();
    let action = match cmd {
        story_parser::Command::Click { .. } => automation::ActionKind::Click,
        story_parser::Command::Type { .. } => automation::ActionKind::Type,
        story_parser::Command::Hover { .. } => automation::ActionKind::Hover,
        story_parser::Command::Drag { .. } => automation::ActionKind::Drag,
        story_parser::Command::Select { .. } => automation::ActionKind::Select,
        story_parser::Command::Upload { .. } => automation::ActionKind::Upload,
        _ => {
            return Err(AppError::InvalidArgument(
                "command has no selector target — cannot promote".into(),
            ));
        }
    };

    let driver = SharedAuthorDriver::new(session.driver.clone());
    automation::try_promote_fallback(&driver, step_id, Some(&session.story_path), action, true)
        .await
        .map_err(|e| AppError::Automation(format!("promote fallback: {e}")))?;
    Ok(())
}

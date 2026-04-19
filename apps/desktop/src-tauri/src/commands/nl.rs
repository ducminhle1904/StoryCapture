//! NL-to-DSL Tauri command surface.
//!
//! Bridges the Rust NL orchestrator to the webview and streams events back.

use std::sync::Arc;
use std::time::Instant;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::commands::keys::ProviderId;
use crate::state::nl_tasks::NlTaskRegistry;
use crate::state::AppState;

use intelligence::llm::LlmProvider;
use intelligence::nl::diff::StepDiff;
use intelligence::nl::orchestrator::{run_nl_turn, ChatTurn, NlTurnEvent};
use intelligence::nl::schemas::StoryDoc;

// ---- Pricing constants (Sonnet 4.6, AI-SPEC section 4b.5) ----

const PRICE_INPUT_UNCACHED: f64 = 3.00;
const PRICE_CACHE_READ: f64 = 0.30;
const PRICE_CACHE_WRITE: f64 = 6.00;
const PRICE_OUTPUT: f64 = 15.00;
const PER_MTOK: f64 = 1_000_000.0;

/// Compute cost_usd from token counts per the Sonnet 4.6 pricing table.
pub fn compute_cost(input: u32, output: u32, cache_read: u32, cache_write: u32) -> f64 {
    let input_uncached = input.saturating_sub(cache_read).saturating_sub(cache_write);
    (f64::from(input_uncached) * PRICE_INPUT_UNCACHED
        + f64::from(cache_read) * PRICE_CACHE_READ
        + f64::from(cache_write) * PRICE_CACHE_WRITE
        + f64::from(output) * PRICE_OUTPUT)
        / PER_MTOK
}

// ---- IPC event type ----

/// Event payload streamed to the webview via `Channel<NlChatEvent>`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NlChatEvent {
    Text {
        delta: String,
    },
    StoryDocReady {
        doc: NlStoryDocDto,
        diff: Vec<NlStepDiffDto>,
        task_id: String,
    },
    Usage {
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
        cost_usd: f64,
    },
    Error {
        message: String,
    },
    Done {
        task_id: String,
    },
}

/// Serialisable DTO mirroring `intelligence::nl::schemas::StoryDoc`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NlStoryDocDto {
    pub title: String,
    pub steps: Vec<NlStoryStepDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NlStoryStepDto {
    pub id: String,
    pub label: String,
    pub verb: String,
    /// JSON-stringified step arguments.
    pub args_json: String,
    pub narration: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NlStepDiffDto {
    pub step_id: String,
    pub kind: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

/// Serialisable DTO for a single conversation turn (history).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NlTurnDto {
    pub id: String,
    pub project_id: String,
    pub turn_index: i64,
    pub role: String,
    pub content: String,
    pub tool_calls_json: Option<String>,
    pub llm_model: Option<String>,
    pub llm_provider: Option<String>,
    pub token_usage_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SessionRollupDto {
    pub turn_count: i64,
    pub total_cost_usd: f64,
    pub total_tokens: i64,
    pub avg_first_token_ms: Option<f64>,
}

// ---- Error type ----

#[derive(Debug, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", content = "message")]
pub enum NlCommandError {
    #[error("invalid project ID")]
    InvalidProject,
    #[error("no API key stored for this provider")]
    NoApiKey,
    #[error("task not found: {0}")]
    TaskNotFound(String),
    #[error("too many in-flight NL turns for this project")]
    TooManyInFlight,
    #[error("invalid provider for LLM: {0}")]
    InvalidProvider(String),
    #[error("orchestrator error: {0}")]
    Orchestrator(String),
    #[error("storage error: {0}")]
    Storage(String),
}

// ---- Conversion helpers ----

fn story_doc_to_dto(doc: &StoryDoc) -> NlStoryDocDto {
    NlStoryDocDto {
        title: doc.title.clone(),
        steps: doc
            .steps
            .iter()
            .map(|s| NlStoryStepDto {
                id: s.id.clone(),
                label: s.label.clone(),
                verb: serde_json::to_value(&s.verb)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| format!("{:?}", s.verb)),
                args_json: serde_json::to_string(&s.args).unwrap_or_default(),
                narration: s.narration.clone(),
            })
            .collect(),
    }
}

fn step_diff_to_dto(d: &StepDiff) -> NlStepDiffDto {
    NlStepDiffDto {
        step_id: d.step_id.clone(),
        kind: format!("{:?}", d.kind).to_lowercase(),
        old_text: d.old_text.clone(),
        new_text: d.new_text.clone(),
    }
}

/// Build an LLM provider from the keychain key.
fn build_provider(
    http_client: reqwest::Client,
    provider_id: ProviderId,
    api_key: &str,
) -> Result<Arc<dyn LlmProvider>, NlCommandError> {
    match provider_id {
        ProviderId::Anthropic => Ok(Arc::new(
            intelligence::llm::anthropic::AnthropicProvider::with_client(
                http_client,
                api_key.to_string(),
            ),
        )),
        ProviderId::Openai => Ok(Arc::new(
            intelligence::llm::openai::OpenAiProvider::with_client(
                http_client,
                api_key.to_string(),
            ),
        )),
        ProviderId::Elevenlabs | ProviderId::OpenaiTts => {
            Err(NlCommandError::InvalidProvider(format!(
                "{:?} is a TTS-only provider, not a valid LLM provider",
                provider_id
            )))
        }
    }
}

// ---- Keychain helper ----

fn read_api_key(provider: ProviderId) -> Result<String, NlCommandError> {
    let entry = keyring::Entry::new(super::keys::SERVICE, provider.account())
        .map_err(|_| NlCommandError::NoApiKey)?;
    entry.get_password().map_err(|_| NlCommandError::NoApiKey)
}

// ---- Commands ----

/// Start an NL-to-DSL turn. Streams events via `on_event` channel.
/// Returns the `task_id` immediately (non-blocking).
#[tauri::command]
#[specta::specta]
pub async fn nl_chat_send(
    app: AppHandle,
    project_id: String,
    user_message: String,
    current_story: String,
    provider_override: Option<ProviderId>,
    on_event: Channel<NlChatEvent>,
) -> Result<String, NlCommandError> {
    // Validate project_id.
    let _pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;

    // Read the API key from keychain.
    let provider_id = provider_override.unwrap_or(ProviderId::Anthropic);
    let api_key = read_api_key(provider_id)?;

    // Build the provider with the shared HTTP client.
    let app_state = app.state::<AppState>();
    let http_client = app_state.http_client.clone();
    let provider = build_provider(http_client, provider_id, &api_key)?;

    // Generate the task ID.
    let task_id = Uuid::now_v7().to_string();

    // Clone the registry for the spawned task.
    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();

    // History loading happens in `nl_load_history`.
    let history: Vec<ChatTurn> = Vec::new();

    // Capture the data dir before spawning.
    let data_dir = app_state.data_dir.clone();
    let started = Instant::now();

    // Spawn the NL turn.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<NlTurnEvent>(64);

    let join_handle = tokio::spawn(async move {
        let _ = run_nl_turn(provider, user_message, current_story, history, out_tx).await;
    });

    // Store the abort handle.
    let inserted = registry.insert(
        task_id.clone(),
        project_id.clone(),
        join_handle.abort_handle(),
    );
    if !inserted {
        join_handle.abort();
        return Err(NlCommandError::TooManyInFlight);
    }

    // Bridge `NlTurnEvent` to `Channel<NlChatEvent>`.
    let task_id_fwd = task_id.clone();
    let project_id_fwd = project_id.clone();
    let provider_name = provider_id.account().to_string();
    let session_id = registry.session_id().to_string();
    let registry_fwd = registry.clone();
    tokio::spawn(async move {
        while let Some(ev) = out_rx.recv().await {
            match ev {
                NlTurnEvent::TextDelta(delta) => {
                    let _ = on_event.send(NlChatEvent::Text { delta });
                }
                NlTurnEvent::StoryDocReady { doc, diff } => {
                    // Store the doc for later `nl_diff_apply`.
                    registry_fwd.store_doc(task_id_fwd.clone(), doc.clone());

                    // Persist the turn best-effort.
                    if let Ok(pid) = Uuid::parse_str(&project_id_fwd) {
                        let _ = persist_turn(&data_dir, &pid, &task_id_fwd, &provider_name);
                    }

                    let dto_doc = story_doc_to_dto(&doc);
                    let dto_diff: Vec<NlStepDiffDto> = diff.iter().map(step_diff_to_dto).collect();
                    let _ = on_event.send(NlChatEvent::StoryDocReady {
                        doc: dto_doc,
                        diff: dto_diff,
                        task_id: task_id_fwd.clone(),
                    });
                }
                NlTurnEvent::Usage {
                    input,
                    output,
                    cache_read,
                    cache_write,
                } => {
                    let cost_usd = compute_cost(input, output, cache_read, cache_write);
                    let total_ms = started.elapsed().as_millis() as i64;

                    // Persist metrics best-effort.
                    if let Ok(pid) = Uuid::parse_str(&project_id_fwd) {
                        let _ = persist_llm_metric(
                            &data_dir,
                            &pid,
                            &task_id_fwd,
                            &provider_name,
                            &session_id,
                            input,
                            output,
                            cache_read,
                            cache_write,
                            cost_usd,
                            total_ms,
                        );
                    }

                    let _ = on_event.send(NlChatEvent::Usage {
                        input,
                        output,
                        cache_read,
                        cache_write,
                        cost_usd,
                    });
                }
                NlTurnEvent::Error(message) => {
                    registry_fwd.remove(&task_id_fwd);
                    let _ = on_event.send(NlChatEvent::Error { message });
                }
                NlTurnEvent::Done => {
                    registry_fwd.remove(&task_id_fwd);
                    let _ = on_event.send(NlChatEvent::Done {
                        task_id: task_id_fwd.clone(),
                    });
                }
            }
        }
    });

    Ok(task_id)
}

/// Cancel an in-flight NL turn.
#[tauri::command]
#[specta::specta]
pub async fn nl_cancel(app: AppHandle, task_id: String) -> Result<(), NlCommandError> {
    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();
    if registry.abort(&task_id) {
        Ok(())
    } else {
        Err(NlCommandError::TaskNotFound(task_id))
    }
}

/// Apply steps from a completed NL turn.
#[tauri::command]
#[specta::specta]
pub async fn nl_diff_apply(
    app: AppHandle,
    project_id: String,
    task_id: String,
    step_ids: Vec<String>,
) -> Result<String, NlCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;

    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();
    let doc = registry
        .take_doc(&task_id)
        .ok_or_else(|| NlCommandError::TaskNotFound(task_id.clone()))?;

    // Filter steps if `step_ids` is non-empty.
    let filtered_doc = if step_ids.is_empty() {
        doc
    } else {
        let filtered_steps: Vec<_> = doc
            .steps
            .into_iter()
            .filter(|s| step_ids.contains(&s.id))
            .collect();
        StoryDoc {
            title: doc.title,
            steps: filtered_steps,
        }
    };

    Ok(filtered_doc.render_dsl())
}

/// Reject a turn's output and drop the cached doc.
#[tauri::command]
#[specta::specta]
pub async fn nl_diff_reject(
    app: AppHandle,
    project_id: String,
    task_id: String,
) -> Result<(), NlCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;

    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();
    registry.drop_doc(&task_id);
    Ok(())
}

/// Regenerate a single step and stream events.
#[tauri::command]
#[specta::specta]
pub async fn nl_regen_step(
    app: AppHandle,
    project_id: String,
    step_id: String,
    current_story: String,
    on_event: Channel<NlChatEvent>,
) -> Result<String, NlCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;

    let provider_id = ProviderId::Anthropic;
    let api_key = read_api_key(provider_id)?;
    let app_state = app.state::<AppState>();
    let http_client = app_state.http_client.clone();
    let provider = build_provider(http_client, provider_id, &api_key)?;

    let task_id = Uuid::now_v7().to_string();
    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();

    let regen_message = format!(
        "Regenerate ONLY step with id={step_id}. Keep all other steps unchanged. \
         The output must include ALL steps from the current story, with only the \
         specified step regenerated."
    );

    let data_dir = app_state.data_dir.clone();
    let project_id_clone = project_id.clone();
    let started = Instant::now();

    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<NlTurnEvent>(64);

    let join_handle = tokio::spawn(async move {
        let _ = run_nl_turn(provider, regen_message, current_story, Vec::new(), out_tx).await;
    });

    let inserted = registry.insert(
        task_id.clone(),
        project_id.clone(),
        join_handle.abort_handle(),
    );
    if !inserted {
        join_handle.abort();
        return Err(NlCommandError::TooManyInFlight);
    }

    // Forward events with the same pattern as `nl_chat_send`.
    let task_id_fwd = task_id.clone();
    let provider_name = provider_id.account().to_string();
    let session_id = registry.session_id().to_string();
    let registry_fwd = registry.clone();
    tokio::spawn(async move {
        while let Some(ev) = out_rx.recv().await {
            match ev {
                NlTurnEvent::TextDelta(delta) => {
                    let _ = on_event.send(NlChatEvent::Text { delta });
                }
                NlTurnEvent::StoryDocReady { doc, diff } => {
                    registry_fwd.store_doc(task_id_fwd.clone(), doc.clone());
                    let dto_doc = story_doc_to_dto(&doc);
                    let dto_diff: Vec<NlStepDiffDto> = diff.iter().map(step_diff_to_dto).collect();
                    let _ = on_event.send(NlChatEvent::StoryDocReady {
                        doc: dto_doc,
                        diff: dto_diff,
                        task_id: task_id_fwd.clone(),
                    });
                }
                NlTurnEvent::Usage {
                    input,
                    output,
                    cache_read,
                    cache_write,
                } => {
                    let cost_usd = compute_cost(input, output, cache_read, cache_write);
                    let total_ms = started.elapsed().as_millis() as i64;
                    if let Ok(pid) = Uuid::parse_str(&project_id_clone) {
                        let _ = persist_llm_metric(
                            &data_dir,
                            &pid,
                            &task_id_fwd,
                            &provider_name,
                            &session_id,
                            input,
                            output,
                            cache_read,
                            cache_write,
                            cost_usd,
                            total_ms,
                        );
                    }
                    let _ = on_event.send(NlChatEvent::Usage {
                        input,
                        output,
                        cache_read,
                        cache_write,
                        cost_usd,
                    });
                }
                NlTurnEvent::Error(message) => {
                    registry_fwd.remove(&task_id_fwd);
                    let _ = on_event.send(NlChatEvent::Error { message });
                }
                NlTurnEvent::Done => {
                    registry_fwd.remove(&task_id_fwd);
                    let _ = on_event.send(NlChatEvent::Done {
                        task_id: task_id_fwd.clone(),
                    });
                }
            }
        }
    });

    Ok(task_id)
}

/// Load conversation history for a project.
#[tauri::command]
#[specta::specta]
pub async fn nl_load_history(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<NlTurnDto>, NlCommandError> {
    let pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;

    let app_state = app.state::<AppState>();
    let db_path = super::util::project_db_path(&app_state, &project_id);

    let conn =
        storage::Connection::open(&db_path).map_err(|e| NlCommandError::Storage(e.to_string()))?;

    let turns = storage::phase3::load_nl_history(&conn, &pid)
        .map_err(|e| NlCommandError::Storage(e.to_string()))?;

    Ok(turns
        .into_iter()
        .map(|t| NlTurnDto {
            id: t.id.to_string(),
            project_id: t.project_id.to_string(),
            turn_index: t.turn_index,
            role: t.role,
            content: t.content,
            tool_calls_json: t.tool_calls_json,
            llm_model: t.llm_model,
            llm_provider: t.llm_provider,
            token_usage_json: t.token_usage_json,
            created_at: t.created_at,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn nl_get_session_id(app: AppHandle) -> Result<String, NlCommandError> {
    let registry: Arc<NlTaskRegistry> = app.state::<Arc<NlTaskRegistry>>().inner().clone();
    Ok(registry.session_id().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn session_get_rollup(
    app: AppHandle,
    project_id: String,
    session_id: String,
) -> Result<SessionRollupDto, NlCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| NlCommandError::InvalidProject)?;
    let app_state = app.state::<AppState>();
    let db_path = super::util::project_db_path(app_state.inner(), &project_id);
    let conn =
        storage::Connection::open(&db_path).map_err(|e| NlCommandError::Storage(e.to_string()))?;

    let rollup = conn
        .query_row(
            "SELECT turn_count, total_cost_usd, total_tokens, avg_first_token_ms \
             FROM session_rollup WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok(SessionRollupDto {
                    turn_count: row.get(0)?,
                    total_cost_usd: row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    total_tokens: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    avg_first_token_ms: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| NlCommandError::Storage(e.to_string()))?;

    Ok(rollup.unwrap_or(SessionRollupDto {
        turn_count: 0,
        total_cost_usd: 0.0,
        total_tokens: 0,
        avg_first_token_ms: None,
    }))
}

// ---- Persistence helpers ----

/// Persist a conversation turn to `nl_conversations`.
fn persist_turn(
    data_dir: &std::path::Path,
    project_id: &Uuid,
    task_id: &str,
    _provider: &str,
) -> Result<(), String> {
    let db_path = super::util::project_db_path_from_dir(data_dir, &project_id.to_string());
    let conn = storage::Connection::open(&db_path).map_err(|e| e.to_string())?;

    // Get next turn_index
    let max_idx: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(turn_index), -1) FROM nl_conversations WHERE project_id = ?1",
            [project_id.to_string()],
            |row| row.get(0),
        )
        .unwrap_or(-1);

    let now = super::util::now_epoch_secs();

    let turn = storage::phase3::NlTurnInsert {
        id: Uuid::now_v7(),
        project_id: *project_id,
        turn_index: max_idx + 1,
        role: "assistant".to_string(),
        content: format!("[NL turn {task_id}]"),
        tool_calls_json: None,
        llm_model: Some(intelligence::llm::DEFAULT_NL_MODEL.to_string()),
        llm_provider: Some("anthropic".to_string()),
        token_usage_json: None,
        created_at: now,
    };

    storage::phase3::insert_nl_turn(&conn, &turn).map_err(|e| e.to_string())
}

/// Persist an LLM turn metric row.
fn persist_llm_metric(
    data_dir: &std::path::Path,
    project_id: &Uuid,
    task_id: &str,
    provider: &str,
    session_id: &str,
    input: u32,
    output: u32,
    cache_read: u32,
    cache_write: u32,
    cost_usd: f64,
    total_ms: i64,
) -> Result<(), String> {
    let db_path = super::util::project_db_path_from_dir(data_dir, &project_id.to_string());
    let conn = storage::Connection::open(&db_path).map_err(|e| e.to_string())?;

    let metric = storage::phase3::LlmTurnMetric {
        turn_id: task_id.to_string(),
        session_id: session_id.to_string(),
        provider: provider.to_string(),
        model: intelligence::llm::DEFAULT_NL_MODEL.to_string(),
        input_tokens: i64::from(input),
        output_tokens: i64::from(output),
        cache_read_tokens: i64::from(cache_read),
        cache_create_tokens: i64::from(cache_write),
        first_token_ms: None,
        total_ms,
        cost_usd,
        error_code: None,
        timestamp: super::util::now_epoch_secs(),
    };

    storage::phase3::insert_llm_metric(&conn, &metric).map_err(|e| e.to_string())
}

//! TTS synthesis Tauri commands with cache + metrics + GC.
//!
//! Four commands:
//!
//! | Command              | Purpose                                          |
//! |----------------------|--------------------------------------------------|
//! | `tts_generate`       | Synthesize TTS clip with cache-first strategy    |
//! | `tts_voice_list`     | List voices for a provider                       |
//! | `tts_regenerate_clip`| Force-regenerate a clip (bypass cache)           |
//! | `tts_gc_cache`       | Garbage-collect cache entries older than 7 days  |
//!
//! Security:
//! - T-03-11-01: step_id sanitized via `cache::sanitize_step_id` before path construction.
//! - T-03-11-04: API key read from keychain per call, never logged via `#[instrument(skip)]`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::commands::keys::ProviderId;
use crate::state::AppState;

use intelligence::tts::cache::{cache_path, hash_key, probe_audio_duration_ms, sanitize_step_id};
use intelligence::tts::voice_presets::CURATED_PRESETS;
use intelligence::tts::{TtsProvider, TtsRequest, VoiceInfo};

// ---- Result + Error types ----

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TtsGenerateResult {
    pub file_path: String,
    pub audio_duration_ms: u64,
    pub cost_usd: f64,
    pub cache_hit: bool,
}

#[derive(Debug, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", content = "message")]
pub enum TtsCommandError {
    #[error("invalid project ID")]
    InvalidProject,
    #[error("no API key stored for this provider")]
    NoApiKey,
    #[error("TTS provider error: {0}")]
    Provider(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("audio probe error: {0}")]
    AudioProbe(String),
}

// ---- Voice info DTO (for specta) ----

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VoiceInfoDto {
    pub id: String,
    pub name: String,
    pub locale: Option<String>,
    pub premium: bool,
}

impl From<VoiceInfo> for VoiceInfoDto {
    fn from(v: VoiceInfo) -> Self {
        Self {
            id: v.id,
            name: v.name,
            locale: v.locale,
            premium: v.premium,
        }
    }
}

// ---- Cost constants ----

/// ElevenLabs: $0.30 per 1K characters
const ELEVENLABS_RATE_PER_1K: f64 = 0.30;
/// OpenAI tts-1: $0.015 per 1K characters
const OPENAI_TTS1_RATE_PER_1K: f64 = 0.015;
/// OpenAI tts-1-hd: $0.030 per 1K characters
const OPENAI_TTS1HD_RATE_PER_1K: f64 = 0.030;

fn compute_tts_cost(provider: ProviderId, model: &str, char_count: usize) -> f64 {
    let rate = match provider {
        ProviderId::Elevenlabs => ELEVENLABS_RATE_PER_1K,
        ProviderId::OpenaiTts => {
            if model.contains("hd") {
                OPENAI_TTS1HD_RATE_PER_1K
            } else {
                OPENAI_TTS1_RATE_PER_1K
            }
        }
        _ => ELEVENLABS_RATE_PER_1K, // fallback
    };
    char_count as f64 * rate / 1000.0
}

// ---- Keychain helper ----

fn read_api_key(provider: ProviderId) -> Result<String, TtsCommandError> {
    let entry = keyring::Entry::new(super::keys::SERVICE, provider.account())
        .map_err(|_| TtsCommandError::NoApiKey)?;
    entry.get_password().map_err(|_| TtsCommandError::NoApiKey)
}

// ---- Provider factory ----

fn build_tts_provider(
    http_client: reqwest::Client,
    provider: ProviderId,
    api_key: &str,
) -> Result<Arc<dyn TtsProvider>, TtsCommandError> {
    match provider {
        ProviderId::Elevenlabs => Ok(Arc::new(
            intelligence::tts::elevenlabs::ElevenLabsProvider::with_client(
                http_client,
                api_key.to_string(),
            ),
        )),
        ProviderId::OpenaiTts => Ok(Arc::new(
            intelligence::tts::openai_tts::OpenAiTtsProvider::with_client(
                http_client,
                api_key.to_string(),
            ),
        )),
        _ => Err(TtsCommandError::Provider(format!(
            "provider {:?} is not a TTS provider",
            provider
        ))),
    }
}

// ---- Project root helper ----

fn project_root(app_state: &AppState, project_id: &str) -> PathBuf {
    app_state.data_dir.join(format!("projects/{project_id}"))
}

use super::util::{now_epoch_ms, project_db_path};

// ---- Commands ----

/// Generate a TTS clip. Cache-first: returns existing MP3 on hash match.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, script_text))]
pub async fn tts_generate(
    app: AppHandle,
    project_id: String,
    step_id: String,
    script_text: String,
    provider: ProviderId,
    voice_id: String,
    model: String,
) -> Result<TtsGenerateResult, TtsCommandError> {
    tts_generate_inner(
        app,
        project_id,
        step_id,
        script_text,
        provider,
        voice_id,
        model,
        false,
    )
    .await
}

/// Regenerate a TTS clip, bypassing the cache.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, script_text))]
pub async fn tts_regenerate_clip(
    app: AppHandle,
    project_id: String,
    step_id: String,
    script_text: String,
    provider: ProviderId,
    voice_id: String,
    model: String,
) -> Result<TtsGenerateResult, TtsCommandError> {
    tts_generate_inner(
        app,
        project_id,
        step_id,
        script_text,
        provider,
        voice_id,
        model,
        true,
    )
    .await
}

/// Shared implementation for tts_generate and tts_regenerate_clip.
async fn tts_generate_inner(
    app: AppHandle,
    project_id: String,
    step_id: String,
    script_text: String,
    provider: ProviderId,
    voice_id: String,
    model: String,
    force: bool,
) -> Result<TtsGenerateResult, TtsCommandError> {
    // T-03-07-01 pattern: validate project_id as UUID
    let _pid = Uuid::parse_str(&project_id).map_err(|_| TtsCommandError::InvalidProject)?;

    let app_state = app.state::<AppState>();
    let root = project_root(&app_state, &project_id);
    let db_path = project_db_path(&app_state, &project_id);

    let provider_str = provider.account();
    let hash = hash_key(provider_str, &model, &voice_id, &script_text);

    // Check cache (unless force-regenerating)
    if !force {
        let conn = storage::Connection::open(&db_path)
            .map_err(|e| TtsCommandError::Storage(e.to_string()))?;

        if let Some(entry) = storage::phase3::lookup_tts_cache(&conn, &hash)
            .map_err(|e| TtsCommandError::Storage(e.to_string()))?
        {
            let file_path = root.join(&entry.file_path);
            if file_path.exists() {
                // Update last_used_at
                let now = now_epoch_ms();
                let updated_entry = storage::phase3::TtsCacheEntry {
                    last_used_at: now,
                    ..entry.clone()
                };
                if let Err(e) = storage::phase3::upsert_tts_cache(&conn, &updated_entry) {
                    tracing::warn!(
                        target: "storycapture::tts",
                        hash = %hash,
                        error = %e,
                        "failed to refresh tts cache last_used_at"
                    );
                }

                // Use stored duration if available; only probe file as fallback
                // for cache entries created before the duration_ms column existed.
                let audio_duration_ms = entry.duration_ms.map(|d| d as u64).unwrap_or_else(|| {
                    let bytes = match std::fs::read(&file_path) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::error!(
                                target: "storycapture::tts",
                                path = %file_path.display(),
                                error = %e,
                                "tts cache probe failed: cannot read audio file; reporting duration=0"
                            );
                            return 0;
                        }
                    };
                    let dur = match probe_audio_duration_ms(&bytes) {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::error!(
                                target: "storycapture::tts",
                                path = %file_path.display(),
                                error = %e,
                                "tts cache probe failed: cannot decode audio duration; reporting duration=0"
                            );
                            return 0;
                        }
                    };
                    let backfill = storage::phase3::TtsCacheEntry {
                        duration_ms: Some(dur as i64),
                        ..entry.clone()
                    };
                    if let Err(e) = storage::phase3::upsert_tts_cache(&conn, &backfill) {
                        tracing::warn!(
                            target: "storycapture::tts",
                            hash = %hash,
                            error = %e,
                            "failed to backfill tts cache duration_ms"
                        );
                    }
                    dur
                });

                // Insert metrics row for cache hit
                let metric = storage::phase3::TtsClipMetric {
                    clip_id: Uuid::now_v7().to_string(),
                    step_id: step_id.clone(),
                    provider: provider_str.to_string(),
                    model: model.clone(),
                    voice_id: voice_id.clone(),
                    char_count: script_text.len() as i64,
                    audio_duration_ms: audio_duration_ms as i64,
                    step_duration_ms: 0,
                    drift_ms: 0,
                    cache_hit: 1,
                    cost_usd: 0.0,
                    first_chunk_ms: None,
                    error_code: None,
                    timestamp: now,
                };
                if let Err(e) = storage::phase3::insert_tts_metric(&conn, &metric) {
                    tracing::warn!(
                        target: "storycapture::tts",
                        clip_id = %metric.clip_id,
                        step_id = ?metric.step_id,
                        error = %e,
                        "failed to record tts cache-hit metric"
                    );
                }

                return Ok(TtsGenerateResult {
                    file_path: file_path.to_string_lossy().to_string(),
                    audio_duration_ms,
                    cost_usd: 0.0,
                    cache_hit: true,
                });
            }
        }
    }

    // Cache miss (or force) — synthesize with shared HTTP client
    let api_key = read_api_key(provider)?;
    let http_client = app_state.http_client.clone();
    let tts_provider = build_tts_provider(http_client, provider, &api_key)?;

    let started = Instant::now();

    let req = TtsRequest {
        model: model.clone(),
        voice_id: voice_id.clone(),
        text: script_text.clone(),
        stability: None,
        similarity_boost: None,
    };

    let audio_bytes = tts_provider
        .synthesize(req)
        .await
        .map_err(|e| TtsCommandError::Provider(e.to_string()))?;

    let first_chunk_ms = started.elapsed().as_millis() as i64;

    // Probe duration
    let audio_duration_ms = probe_audio_duration_ms(&audio_bytes)
        .map_err(|e| TtsCommandError::AudioProbe(e.to_string()))?;

    // Write to disk
    let path =
        cache_path(&root, &step_id, &hash).map_err(|e| TtsCommandError::Io(e.to_string()))?;

    std::fs::write(&path, &audio_bytes).map_err(|e| TtsCommandError::Io(e.to_string()))?;

    // Compute cost
    let char_count = script_text.len();
    let cost_usd = compute_tts_cost(provider, &model, char_count);

    // Compute relative file_path for cache index (must start with "voiceover/")
    let relative_path = path.strip_prefix(&root).unwrap_or(&path);

    // Upsert cache index
    let now = now_epoch_ms();
    let conn =
        storage::Connection::open(&db_path).map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    let cache_entry = storage::phase3::TtsCacheEntry {
        hash: hash.clone(),
        step_id: sanitize_step_id(&step_id),
        project_id: project_id.clone(),
        file_path: relative_path.to_path_buf(),
        provider: provider_str.to_string(),
        model: model.clone(),
        voice_id: voice_id.clone(),
        script_sha: hash.clone(), // content hash is the same
        byte_size: audio_bytes.len() as i64,
        duration_ms: Some(audio_duration_ms as i64),
        created_at: now,
        last_used_at: now,
    };
    storage::phase3::upsert_tts_cache(&conn, &cache_entry)
        .map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    // Insert TTS clip metric
    let metric = storage::phase3::TtsClipMetric {
        clip_id: Uuid::now_v7().to_string(),
        step_id: step_id.clone(),
        provider: provider_str.to_string(),
        model: model.clone(),
        voice_id: voice_id.clone(),
        char_count: char_count as i64,
        audio_duration_ms: audio_duration_ms as i64,
        step_duration_ms: 0,
        drift_ms: 0,
        cache_hit: 0,
        cost_usd,
        first_chunk_ms: Some(first_chunk_ms),
        error_code: None,
        timestamp: now,
    };
    storage::phase3::insert_tts_metric(&conn, &metric)
        .map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    Ok(TtsGenerateResult {
        file_path: path.to_string_lossy().to_string(),
        audio_duration_ms,
        cost_usd,
        cache_hit: false,
    })
}

/// List voices for a TTS provider.
///
/// For ElevenLabs, curated presets come first, then the full catalog
/// with duplicates removed.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn tts_voice_list(
    app: AppHandle,
    provider: ProviderId,
) -> Result<Vec<VoiceInfoDto>, TtsCommandError> {
    let app_state = app.state::<AppState>();
    let http_client = app_state.http_client.clone();

    match provider {
        ProviderId::OpenaiTts => {
            // Static list — no network call needed
            let p = intelligence::tts::openai_tts::OpenAiTtsProvider::with_client(
                http_client,
                "unused".to_string(),
            );
            let voices = p
                .list_voices()
                .await
                .map_err(|e| TtsCommandError::Provider(e.to_string()))?;
            Ok(voices.into_iter().map(VoiceInfoDto::from).collect())
        }
        ProviderId::Elevenlabs => {
            let api_key = read_api_key(provider)?;
            let p = intelligence::tts::elevenlabs::ElevenLabsProvider::with_client(
                http_client,
                api_key,
            );
            let all_voices = p
                .list_voices()
                .await
                .map_err(|e| TtsCommandError::Provider(e.to_string()))?;

            // Curated presets come first
            let mut result: Vec<VoiceInfoDto> = CURATED_PRESETS
                .iter()
                .map(|cp| VoiceInfoDto {
                    id: cp.voice_id.to_string(),
                    name: cp.display_name.to_string(),
                    locale: Some(cp.locale.to_string()),
                    premium: false,
                })
                .collect();

            // Merge remaining, dedup by voice_id
            let curated_ids: Vec<&str> = CURATED_PRESETS.iter().map(|p| p.voice_id).collect();
            for v in all_voices {
                if !curated_ids.contains(&v.id.as_str()) {
                    result.push(VoiceInfoDto::from(v));
                }
            }

            Ok(result)
        }
        _ => Err(TtsCommandError::Provider(format!(
            "{:?} is not a TTS provider",
            provider
        ))),
    }
}

/// Garbage-collect TTS cache entries older than 7 days.
///
/// Returns the number of entries removed.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn tts_gc_cache(app: AppHandle, project_id: String) -> Result<u64, TtsCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| TtsCommandError::InvalidProject)?;

    let app_state = app.state::<AppState>();
    let root = project_root(&app_state, &project_id);
    let db_path = project_db_path(&app_state, &project_id);

    let conn =
        storage::Connection::open(&db_path).map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    let seven_days_ms: i64 = 7 * 24 * 60 * 60 * 1000;
    let cutoff = now_epoch_ms() - seven_days_ms;

    let removed = storage::phase3::gc_tts_cache_older_than(&conn, cutoff, |rel_path| {
        // rel_path is the relative path stored in the cache index
        // (e.g. "voiceover/step-abc123.mp3"). Resolve against project root.
        let abs_path = root.join(rel_path);
        if abs_path.exists() {
            std::fs::remove_file(&abs_path)?;
        }
        Ok(())
    })
    .map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    tracing::info!(
        target: "storycapture::tts",
        project_id = %project_id,
        removed = removed,
        "tts_gc_cache completed"
    );

    Ok(removed)
}

// ---- Sync plan types (specta-compatible DTOs) ----

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AdjustedStepDto {
    pub step_id: String,
    pub new_duration_ms: u64,
    pub freeze_frame_extension_ms: u64,
    pub silence_padding_ms: u64,
    pub clip_start_ms: u64,
    pub drift_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DuckEventDto {
    pub start_ms: u64,
    pub end_ms: u64,
    pub db: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncPlanDto {
    pub adjusted_steps: Vec<AdjustedStepDto>,
    pub duck_events: Vec<DuckEventDto>,
}

/// Compute a TTS voiceover-to-timeline sync plan and emit duck events
/// to the sound mixer (Phase 2 D-22 slot).
///
/// This command accepts step timings directly (Phase 2 effects AST
/// integration is deferred — when Phase 2 is fully merged, this will
/// load step timings from the project's effects AST instead of
/// requiring them as a parameter).
///
/// Flow:
/// 1. Load ClipMeta by scanning tts_cache_index + probing audio durations.
/// 2. Call `compute_sync_plan`.
/// 3. Emit duck_events via `app.emit("sound_mixer/duck_events", ...)`.
/// 4. Persist drift_ms in tts_clip_metrics for each clip.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, step_timings))]
pub async fn tts_apply_sync(
    app: AppHandle,
    project_id: String,
    step_timings: Vec<StepTimingDto>,
) -> Result<SyncPlanDto, TtsCommandError> {
    let _pid = Uuid::parse_str(&project_id).map_err(|_| TtsCommandError::InvalidProject)?;

    let app_state = app.state::<AppState>();
    let root = project_root(&app_state, &project_id);
    let db_path = project_db_path(&app_state, &project_id);

    let conn =
        storage::Connection::open(&db_path).map_err(|e| TtsCommandError::Storage(e.to_string()))?;

    // Convert DTO step timings to intelligence types.
    let steps: Vec<intelligence::tts::sync::StepTiming> = step_timings
        .iter()
        .map(|s| intelligence::tts::sync::StepTiming {
            step_id: s.step_id.clone(),
            original_duration_ms: s.original_duration_ms,
        })
        .collect();

    // Load ClipMeta by scanning the tts_cache_index for this project's steps.
    let mut clip_metas: Vec<intelligence::tts::sync::ClipMeta> = Vec::new();
    for st in &steps {
        if let Some(entry) =
            storage::phase3::lookup_tts_cache_by_step(&conn, &st.step_id).unwrap_or(None)
        {
            let abs_path = root.join(&entry.file_path);
            let audio_duration_ms = if abs_path.exists() {
                let bytes =
                    std::fs::read(&abs_path).map_err(|e| TtsCommandError::Io(e.to_string()))?;
                probe_audio_duration_ms(&bytes).unwrap_or(0)
            } else {
                0
            };
            clip_metas.push(intelligence::tts::sync::ClipMeta {
                step_id: st.step_id.clone(),
                audio_duration_ms,
                file_path: abs_path,
            });
        }
    }

    // Compute sync plan.
    let plan = intelligence::tts::sync::compute_sync_plan(&steps, &clip_metas);

    // Emit duck_events to the sound mixer actor (Phase 2 D-22 slot).
    let duck_dtos: Vec<DuckEventDto> = plan
        .duck_events
        .iter()
        .map(|d| DuckEventDto {
            start_ms: d.start_ms,
            end_ms: d.end_ms,
            db: d.db,
        })
        .collect();
    if let Err(e) = app.emit("sound_mixer/duck_events", &duck_dtos) {
        tracing::warn!(
            target: "storycapture::tts",
            count = duck_dtos.len(),
            error = %e,
            "failed to emit sound_mixer/duck_events; renderer will miss duck schedule"
        );
    }

    // Persist drift_ms in tts_clip_metrics for each adjusted step.
    for adj in &plan.adjusted_steps {
        if let Err(e) =
            storage::phase3::update_tts_metric_drift(&conn, &adj.step_id, adj.drift_ms)
        {
            tracing::warn!(
                target: "storycapture::tts",
                step_id = %adj.step_id,
                drift_ms = adj.drift_ms,
                error = %e,
                "failed to persist tts drift_ms"
            );
        }
    }

    // Convert to DTO.
    let dto = SyncPlanDto {
        adjusted_steps: plan
            .adjusted_steps
            .iter()
            .map(|a| AdjustedStepDto {
                step_id: a.step_id.clone(),
                new_duration_ms: a.new_duration_ms,
                freeze_frame_extension_ms: a.freeze_frame_extension_ms,
                silence_padding_ms: a.silence_padding_ms,
                clip_start_ms: a.clip_start_ms,
                drift_ms: a.drift_ms,
            })
            .collect(),
        duck_events: duck_dtos,
    };

    tracing::info!(
        target: "storycapture::tts",
        project_id = %project_id,
        steps = plan.adjusted_steps.len(),
        duck_events = plan.duck_events.len(),
        "tts_apply_sync completed"
    );

    Ok(dto)
}

/// Step timing DTO for the `tts_apply_sync` command.
///
/// Phase 2 hand-off note: when Phase 2 effects AST is fully merged,
/// this parameter can be replaced by loading step timings from the
/// project's effects AST directly.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct StepTimingDto {
    pub step_id: String,
    pub original_duration_ms: u64,
}

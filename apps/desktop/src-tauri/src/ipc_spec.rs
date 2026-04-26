// ipc_spec.rs — single source of truth for the typed IPC surface.
//
// Builds the `tauri_specta::Builder` listing every exported command + every
// custom payload type. `lib.rs::run()` consumes `builder()` and:
//   1. In debug builds, calls `.export(...)` to emit fresh TS bindings to
//      `packages/shared-types/src/ipc.ts` on every `pnpm tauri dev`.
//   2. In every build, hands the resulting `invoke_handler` to Tauri.
//
// Adding a command to the host:
//   1. Define it in `commands/<feature>.rs` with `#[tauri::command]` AND
//      `#[specta::specta]`.
//   2. Reference it in the `collect_commands!` macro below.
//   3. (Optional) Reference any new custom types in `collect_types!`.
//   4. The next `pnpm tauri dev` regenerates `packages/shared-types/src/ipc.ts`.

use tauri::Wry;
use tauri_specta::{collect_commands, Builder};

use crate::{
    commands::{
        app_settings, audio, author_snapshot, automation, capture, dryrun, encode, export,
        frontend_log, keys, lsp, nl, parse, picker, preset, projects, region_overlay, render,
        simulator, sound_library, system, timeline, tts, updater, upload, web_account, web_sync,
    },
    error::AppError,
};

/// Constructs the tauri-specta builder. Called from `lib.rs::run()`.
///
/// IMPORTANT: when `cfg(debug_assertions)` is set (i.e. `cargo run` /
/// `pnpm tauri dev`), this builder also writes `packages/shared-types/src/ipc.ts`.
/// In release builds the builder is still consumed for command dispatch
/// but no file IO happens.
///
/// `trigger_panic` is included unconditionally in the command list (the
/// `collect_commands!` macro doesn't accept `#[cfg]` arms) — the command
/// itself is `#[cfg(debug_assertions)]` so it compiles only in dev
/// builds; release builds drop the symbol but still register a no-op.
pub fn builder() -> Builder<Wry> {
    Builder::<Wry>::new()
        .commands(collect_commands![
            system::ping,
            system::app_info,
            system::store_secret,
            system::load_secret,
            system::delete_secret,
            system::trigger_panic,
            frontend_log::log_from_frontend,
            automation::launch_automation,
            automation::resolve_playwright_target,
            automation::is_stage_manager_enabled,
            // Live preview pump (Rust → `preview://frame`).
            automation::start_preview_stream,
            automation::stop_preview_stream,
            // Author-time preview.
            automation::start_author_preview,
            automation::stop_author_preview,
            automation::pause_author_preview,
            automation::resume_author_preview,
            automation::set_author_preview_viewport,
            automation::set_author_preview_url,
            automation::author_preview_back,
            automation::author_preview_forward,
            automation::author_preview_reload,
            automation::attach_author_driver,
            automation::author_dispatch_input,
            // element picker.
            picker::picker_start,
            picker::picker_cancel,
            picker::picker_is_active,
            // stamp UUIDv7 on first pick + seed targets sidecar.
            picker::picker_stamp_step_id,
            // Preview-panel Pick against author-session.
            picker::picker_start_author,
            // author-time selector validator + DOM snapshot store.
            author_snapshot::author_snapshot_capture,
            author_snapshot::author_snapshot_get,
            author_snapshot::author_snapshot_list,
            author_snapshot::author_snapshot_validate,
            app_settings::get_app_settings,
            app_settings::set_browser_executable,
            app_settings::set_live_preview_enabled,
            app_settings::get_log_config,
            app_settings::set_log_config,
            app_settings::open_log_dir,
            // Mic audio enumeration.
            audio::list_audio_inputs,
            capture::list_displays,
            capture::list_windows,
            capture::list_capture_targets,
            capture::check_screen_capture_permission,
            capture::open_screen_capture_prefs,
            capture::request_screen_capture_access,
            capture::relaunch_app,
            capture::start_capture,
            capture::start_capture_target,
            capture::stop_capture,
            capture::get_capture_target,
            capture::set_capture_target,
            // One-shot thumbnail for recorder preview.
            capture::capture_target_thumbnail,
            // Region selection overlay.
            region_overlay::open_region_overlay,
            region_overlay::close_region_overlay,
            encode::probe_hw_encoders,
            encode::refresh_hw_encoders,
            encode::start_recording,
            encode::pause_recording,
            encode::resume_recording,
            encode::stop_recording,
            parse::parse_story,
            projects::list_projects,
            projects::create_project,
            projects::open_project,
            projects::remove_project,
            projects::list_project_recordings,
            render::render_enqueue,
            render::render_cancel,
            render::render_list_active,
            render::stream_render_progress,
            export::export_run,
            export::export_get_presets,
            export::export_validate_config,
            preset::preset_list,
            preset::preset_import,
            preset::preset_export,
            timeline::timeline_load,
            timeline::timeline_save,
            sound_library::sound_library_list,
            updater::check_update,
            updater::install_update,
            // AI provider key management.
            keys::key_set,
            keys::key_get_presence,
            keys::key_delete,
            keys::key_test,
            // Dry-Run orchestrator.
            dryrun::dryrun_start,
            dryrun::dryrun_cancel,
            // Author-time simulator (distinct from dryrun).
            simulator::simulator_start,
            simulator::simulator_step_to,
            simulator::simulator_cancel,
            simulator::simulator_promote_fallback,
            // LSP IPC bridge.
            lsp::lsp_request,
            // NL-to-DSL commands.
            nl::nl_chat_send,
            nl::nl_cancel,
            nl::nl_diff_apply,
            nl::nl_diff_reject,
            nl::nl_regen_step,
            nl::nl_load_history,
            nl::nl_get_session_id,
            nl::session_get_rollup,
            // TTS synthesis + cache + GC.
            tts::tts_generate,
            tts::tts_voice_list,
            tts::tts_regenerate_clip,
            tts::tts_gc_cache,
            // TTS voiceover sync engine.
            tts::tts_apply_sync,
            // Upload pipeline.
            upload::upload_video,
            upload::cancel_upload,
            upload::get_upload_status,
            // Web account OAuth + keychain.
            web_account::start_web_oauth,
            web_account::complete_web_oauth,
            web_account::get_web_account,
            web_account::disconnect_web_account,
            web_account::get_web_api_token,
            // Desktop-web sync with offline queue.
            web_sync::sync_project_metadata,
            web_sync::update_recording_status,
            web_sync::flush_sync_queue,
            web_sync::get_sync_status,
        ])
        .typ::<AppError>()
        .typ::<app_settings::AppSettingsDto>()
        .typ::<app_settings::LogConfigDto>()
        .typ::<app_settings::LogConfigUpdate>()
        .typ::<system::AppInfo>()
        .typ::<crate::panic_hook::PanicPayload>()
        .typ::<frontend_log::FrontendLogLevel>()
        .typ::<frontend_log::FrontendLogPayload>()
        .typ::<automation::ResolvedPlaywrightTarget>()
        .typ::<automation::AuthorViewportArgs>()
        .typ::<automation::AuthorInputEvent>()
        .typ::<automation::AuthorMouseButton>()
        .typ::<automation::AuthorPreviewNavPayload>()
        .typ::<picker::PickElementResponseDto>()
        .typ::<picker::PickerStampResultDto>()
        // author-time validator DTOs.
        .typ::<author_snapshot::AuthorSnapshotEntry>()
        .typ::<author_snapshot::AuthorValidationDto>()
        .typ::<capture::DisplayInfoDto>()
        .typ::<capture::WindowInfoDto>()
        .typ::<capture::CaptureTargetDto>()
        .typ::<capture::RegionRectDto>()
        .typ::<capture::CaptureTargetsDto>()
        .typ::<capture::StartCaptureTargetArgs>()
        .typ::<capture::PermissionState>()
        .typ::<capture::CaptureConfigDto>()
        .typ::<capture::CaptureStatsDto>()
        .typ::<capture::CaptureEventDto>()
        .typ::<capture::FrameMetaDto>()
        .typ::<capture::SessionId>()
        .typ::<encode::HardwareEncoderDto>()
        .typ::<encode::EncoderProbeDto>()
        .typ::<encode::EncodeResultDto>()
        .typ::<encode::EncodeProgressDto>()
        .typ::<encode::RecordingEvent>()
        .typ::<encode::RecordingSessionId>()
        .typ::<encode::StartRecordingArgs>()
        .typ::<encode::OutputResolutionDto>()
        .typ::<encode::FitModeDto>()
        .typ::<encode::PadColorDto>()
        .typ::<encode::QualityPresetDto>()
        .typ::<encode::ScaleAlgoDto>()
        .typ::<audio::AudioInputInfoDto>()
        // parse + projects
        .typ::<parse::ParseResultDto>()
        .typ::<parse::StoryDto>()
        .typ::<parse::SceneDto>()
        .typ::<parse::CommandDto>()
        .typ::<parse::MetaDto>()
        .typ::<parse::ViewportDto>()
        .typ::<parse::ThemeDto>()
        .typ::<parse::SelectorOrTextDto>()
        .typ::<parse::ScrollDirDto>()
        .typ::<parse::DiagnosticDto>()
        .typ::<parse::SeverityDto>()
        .typ::<parse::SpanDto>()
        .typ::<projects::ProjectDto>()
        .typ::<projects::ProjectFolderInfoDto>()
        .typ::<projects::CreateProjectArgs>()
        .typ::<projects::ProjectIdArg>()
        .typ::<projects::RecordingInfoDto>()
        // render queue
        .typ::<render::NewRenderJobDto>()
        .typ::<render::RenderJobDto>()
        .typ::<render::RenderProgressDto>()
        // export
        .typ::<export::ExportOutputDto>()
        .typ::<export::ExportRunArgs>()
        .typ::<export::ExportResultDto>()
        .typ::<export::ExportPresetsCatalogue>()
        // export knobs
        .typ::<export::EncoderOptionsDto>()
        .typ::<export::AudioOptionsDto>()
        .typ::<export::ContainerDto>()
        .typ::<export::CodecDto>()
        .typ::<export::RateControlDto>()
        .typ::<export::X264PresetDto>()
        .typ::<export::AudioCodecDto>()
        // preset / timeline / sound-library
        .typ::<preset::PresetScopeDto>()
        .typ::<preset::EffectPresetDto>()
        .typ::<timeline::TimelineStateDto>()
        .typ::<sound_library::SoundCategoryDto>()
        .typ::<sound_library::SoundLibraryEntryDto>()
        // auto-updater
        .typ::<updater::UpdateInfo>()
        // AI key management
        .typ::<keys::ProviderId>()
        .typ::<keys::KeyTestReport>()
        .typ::<keys::KeyError>()
        // Dry-Run
        .typ::<dryrun::DryRunEventDto>()
        .typ::<dryrun::DryRunStepDto>()
        // Simulator
        .typ::<simulator::SimulatorEvent>()
        .typ::<simulator::SimulatorStepFrame>()
        .typ::<simulator::SimulatorBbox>()
        .typ::<simulator::SimulatorMatchKind>()
        // LSP IPC bridge
        .typ::<lsp::LspNotificationDto>()
        // NL-to-DSL commands
        .typ::<nl::NlChatEvent>()
        .typ::<nl::NlStoryDocDto>()
        .typ::<nl::NlStoryStepDto>()
        .typ::<nl::NlStepDiffDto>()
        .typ::<nl::NlTurnDto>()
        .typ::<nl::SessionRollupDto>()
        .typ::<nl::NlCommandError>()
        // TTS synthesis + cache
        .typ::<tts::TtsGenerateResult>()
        .typ::<tts::TtsCommandError>()
        .typ::<tts::VoiceInfoDto>()
        // TTS voiceover sync
        .typ::<tts::SyncPlanDto>()
        .typ::<tts::AdjustedStepDto>()
        .typ::<tts::DuckEventDto>()
        .typ::<tts::StepTimingDto>()
        // Upload pipeline
        .typ::<upload::UploadProgressEvent>()
        .typ::<upload::UploadResult>()
        .typ::<upload::UploadStatusDto>()
        .typ::<upload::UploadError>()
        // Web account OAuth
        .typ::<web_account::WebAccountInfo>()
        .typ::<web_account::WebAccountError>()
        // Desktop-web sync
        .typ::<web_sync::SyncResult>()
        .typ::<web_sync::FlushResult>()
        .typ::<web_sync::SyncStatusDto>()
        .typ::<web_sync::WebSyncError>()
}

/// Path (relative to the `apps/desktop/src-tauri` crate root) where the
/// generated TS bindings are written in debug builds.
pub const TS_BINDINGS_PATH: &str = "../../../packages/shared-types/src/ipc.ts";

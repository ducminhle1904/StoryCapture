// ipc_spec.rs — single source of truth for the typed IPC surface (D-05).
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
        automation, capture, dryrun, encode, export, keys, lsp, nl, parse, preset, projects,
        render, sound_library, system, timeline, tts, updater,
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
            automation::launch_automation,
            capture::list_displays,
            capture::check_screen_capture_permission,
            capture::open_screen_capture_prefs,
            capture::relaunch_app,
            capture::start_capture,
            capture::stop_capture,
            encode::probe_hw_encoders,
            encode::start_recording,
            encode::stop_recording,
            parse::parse_story,
            projects::list_projects,
            projects::create_project,
            projects::open_project,
            projects::remove_project,
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
            // Phase 03 plan 03 — AI provider key management.
            keys::key_set,
            keys::key_get_presence,
            keys::key_delete,
            keys::key_test,
            // Phase 03 plan 16 — Dry-Run orchestrator.
            dryrun::dryrun_start,
            dryrun::dryrun_cancel,
            // Phase 03 plan 14 — LSP IPC bridge.
            lsp::lsp_request,
            // Phase 03 plan 07 — NL-to-DSL commands.
            nl::nl_chat_send,
            nl::nl_cancel,
            nl::nl_diff_apply,
            nl::nl_diff_reject,
            nl::nl_regen_step,
            nl::nl_load_history,
            // Phase 03 plan 11 — TTS synthesis + cache + GC.
            tts::tts_generate,
            tts::tts_voice_list,
            tts::tts_regenerate_clip,
            tts::tts_gc_cache,
            // Phase 03 plan 12 — TTS voiceover sync engine.
            tts::tts_apply_sync,
        ])
        .typ::<AppError>()
        .typ::<system::AppInfo>()
        .typ::<crate::panic_hook::PanicPayload>()
        .typ::<capture::DisplayInfoDto>()
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
        // Plan 01-09 (parse + projects)
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
        // Plan 02-10 (render queue)
        .typ::<render::NewRenderJobDto>()
        .typ::<render::RenderJobDto>()
        .typ::<render::RenderProgressDto>()
        // Plan 02-11 (export)
        .typ::<export::ExportOutputDto>()
        .typ::<export::ExportRunArgs>()
        .typ::<export::ExportResultDto>()
        .typ::<export::ExportPresetsCatalogue>()
        // Plan 02-12a (preset / timeline / sound-library)
        .typ::<preset::PresetScopeDto>()
        .typ::<preset::EffectPresetDto>()
        .typ::<timeline::TimelineStateDto>()
        .typ::<sound_library::SoundCategoryDto>()
        .typ::<sound_library::SoundLibraryEntryDto>()
        // Plan 01-10 (auto-updater)
        .typ::<updater::UpdateInfo>()
        // Phase 03 plan 03 (AI key management)
        .typ::<keys::ProviderId>()
        .typ::<keys::KeyTestReport>()
        .typ::<keys::KeyError>()
        // Phase 03 plan 16 (Dry-Run)
        .typ::<dryrun::DryRunEventDto>()
        .typ::<dryrun::DryRunStepDto>()
        // Phase 03 plan 14 (LSP IPC bridge)
        .typ::<lsp::LspNotificationDto>()
        // Phase 03 plan 07 (NL-to-DSL commands)
        .typ::<nl::NlChatEvent>()
        .typ::<nl::NlStoryDocDto>()
        .typ::<nl::NlStoryStepDto>()
        .typ::<nl::NlStepDiffDto>()
        .typ::<nl::NlTurnDto>()
        .typ::<nl::NlCommandError>()
        // Phase 03 plan 11 (TTS synthesis + cache)
        .typ::<tts::TtsGenerateResult>()
        .typ::<tts::TtsCommandError>()
        .typ::<tts::VoiceInfoDto>()
        // Phase 03 plan 12 (TTS voiceover sync)
        .typ::<tts::SyncPlanDto>()
        .typ::<tts::AdjustedStepDto>()
        .typ::<tts::DuckEventDto>()
        .typ::<tts::StepTimingDto>()
}

/// Path (relative to the `apps/desktop/src-tauri` crate root) where the
/// generated TS bindings are written in debug builds.
pub const TS_BINDINGS_PATH: &str = "../../../packages/shared-types/src/ipc.ts";

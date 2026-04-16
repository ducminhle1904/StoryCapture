// Command registry for the StoryCapture host (Phase 1 plan 01-03).
//
// Plans 04 (DSL parse/run), 05 (DSL parser glue), 06 (BrowserDriver),
// 07 (capture), 08 (encoder), 09 (storage) each add their own submodule
// here and extend `ipc_spec::builder()` accordingly.

pub mod automation;
pub mod capture;
pub mod dryrun;
pub mod encode;
pub mod export;
pub mod keys;
pub mod lsp;
pub mod nl;
pub mod parse;
pub mod preset;
pub mod projects;
pub mod render;
pub mod sound_library;
pub mod system;
pub mod timeline;
pub mod tts;
pub mod updater;
pub mod util;
pub mod upload;
pub mod web_account;
pub mod web_sync;

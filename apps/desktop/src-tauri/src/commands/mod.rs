// Command registry for the StoryCapture host (Phase 1 plan 01-03).
//
// Plans 04 (DSL parse/run), 05 (DSL parser glue), 06 (BrowserDriver),
// 07 (capture), 08 (encoder), 09 (storage) each add their own submodule
// here and extend `ipc_spec::builder()` accordingly.

pub mod automation;
pub mod capture;
pub mod encode;
pub mod parse;
pub mod projects;
pub mod system;

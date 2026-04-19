//! `tower-lsp` `LanguageServer` implementation for `.story` files.
//!
//! Architecture: shares the `crates/story-parser` crate directly
//! — no stdio, no sidecar. The IPC bridge (tauri → lsp) lands in a
//! follow-up plan.
//!
//! Documents are stored as `ropey::Rope` inside a `DashMap<Url, Rope>`
//! for incremental edits.

use dashmap::DashMap;
use ropey::Rope;
use tower_lsp::jsonrpc::Result as LspResult;
use tower_lsp::lsp_types::{
    CompletionItem, CompletionItemKind, CompletionOptions, CompletionParams, CompletionResponse,
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    Documentation, Hover, HoverContents, HoverParams, HoverProviderCapability, InitializeParams,
    InitializeResult, InitializedParams, MarkupContent, MarkupKind, MessageType, OneOf,
    ServerCapabilities, ServerInfo, TextDocumentSyncCapability, TextDocumentSyncKind, Url,
};
use tower_lsp::{Client, LanguageServer};

use crate::lsp::diagnostics::{diagnose, verb_doc, verb_list};
use crate::lsp::document::{apply_changes, identifier_at};

/// In-process language server state.
pub struct StoryLanguageServer {
    client: Client,
    docs: DashMap<Url, Rope>,
}

impl StoryLanguageServer {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            docs: DashMap::new(),
        }
    }

    /// Test-only snapshot of a document's text.
    #[cfg(test)]
    pub(crate) fn doc_text(&self, uri: &Url) -> Option<String> {
        self.docs.get(uri).map(|r| r.to_string())
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for StoryLanguageServer {
    async fn initialize(&self, _: InitializeParams) -> LspResult<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::INCREMENTAL,
                )),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                completion_provider: Some(CompletionOptions {
                    resolve_provider: Some(false),
                    trigger_characters: Some(vec![" ".into(), "\n".into()]),
                    all_commit_characters: None,
                    work_done_progress_options: Default::default(),
                    completion_item: None,
                }),
                definition_provider: Some(OneOf::Left(false)),
                ..ServerCapabilities::default()
            },
            server_info: Some(ServerInfo {
                name: "story-language-server".into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            }),
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "story-language-server initialized")
            .await;
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let rope = Rope::from_str(&params.text_document.text);
        let text = rope.to_string();
        self.docs.insert(uri.clone(), rope);

        let rope_ref = Rope::from_str(&text);
        let diags = diagnose(&text, &rope_ref);
        self.client.publish_diagnostics(uri, diags, None).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        let Some(mut entry) = self.docs.get_mut(&uri) else {
            return;
        };
        apply_changes(entry.value_mut(), &params.content_changes);
        let text = entry.to_string();
        drop(entry);

        let rope_ref = Rope::from_str(&text);
        let diags = diagnose(&text, &rope_ref);
        self.client.publish_diagnostics(uri, diags, None).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri.clone();
        self.docs.remove(&uri);
        // Clear published diagnostics per LSP convention.
        self.client.publish_diagnostics(uri, vec![], None).await;
    }

    async fn hover(&self, params: HoverParams) -> LspResult<Option<Hover>> {
        let uri = &params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;
        let Some(rope) = self.docs.get(uri) else {
            return Ok(None);
        };
        let Some((ident, range)) = identifier_at(rope.value(), pos) else {
            return Ok(None);
        };
        let Some(doc) = verb_doc(&ident) else {
            return Ok(None);
        };
        Ok(Some(Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: doc.to_string(),
            }),
            range: Some(range),
        }))
    }

    async fn completion(&self, params: CompletionParams) -> LspResult<Option<CompletionResponse>> {
        let uri = &params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;
        let prefix = self
            .docs
            .get(uri)
            .and_then(|rope| identifier_at(rope.value(), pos).map(|(p, _)| p))
            .unwrap_or_default();

        let items: Vec<CompletionItem> = verb_list()
            .into_iter()
            .filter(|v| prefix.is_empty() || v.starts_with(&prefix))
            .map(|v| CompletionItem {
                label: v.to_string(),
                kind: Some(CompletionItemKind::KEYWORD),
                detail: Some("story verb".to_string()),
                documentation: verb_doc(v).map(|d| {
                    Documentation::MarkupContent(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: d.to_string(),
                    })
                }),
                insert_text: Some(v.to_string()),
                ..CompletionItem::default()
            })
            .collect();

        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn shutdown(&self) -> LspResult<()> {
        Ok(())
    }
}

// ---- In-process test harness ----
//
// Building a real `Client` requires wiring up a `LspService`; for the
// integration tests we expose a thin facade that exercises the same
// logic without the JSON-RPC transport. The facade and the
// `LanguageServer` impl share all state through the `docs` DashMap and
// call into the same diagnostic / hover / completion helpers.

/// Test-only in-process server that skips the `Client` RPC plumbing.
///
/// Used by `tests/lsp_server_tests.rs` to pump document events and
/// observe diagnostics without standing up a duplex transport.
#[doc(hidden)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;
    use tower_lsp::lsp_types::{
        DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    };

    /// Record of a `publish_diagnostics` call.
    #[derive(Debug, Clone)]
    pub struct DiagnosticsPublish {
        pub uri: Url,
        pub diagnostics: Vec<tower_lsp::lsp_types::Diagnostic>,
    }

    /// In-process server: same logic as `StoryLanguageServer` minus the
    /// `Client` dependency.
    pub struct InProcessServer {
        pub docs: DashMap<Url, Rope>,
        published: Mutex<Vec<DiagnosticsPublish>>,
    }

    impl Default for InProcessServer {
        fn default() -> Self {
            Self::new()
        }
    }

    impl InProcessServer {
        pub fn new() -> Self {
            Self {
                docs: DashMap::new(),
                published: Mutex::new(Vec::new()),
            }
        }

        pub fn published(&self) -> Vec<DiagnosticsPublish> {
            self.published.lock().unwrap().clone()
        }

        pub fn latest(&self, uri: &Url) -> Option<DiagnosticsPublish> {
            self.published
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|p| &p.uri == uri)
                .cloned()
        }

        fn publish(&self, uri: Url, diagnostics: Vec<tower_lsp::lsp_types::Diagnostic>) {
            self.published
                .lock()
                .unwrap()
                .push(DiagnosticsPublish { uri, diagnostics });
        }

        pub fn did_open(&self, params: DidOpenTextDocumentParams) {
            let uri = params.text_document.uri.clone();
            let rope = Rope::from_str(&params.text_document.text);
            let text = rope.to_string();
            self.docs.insert(uri.clone(), rope);

            let rope_ref = Rope::from_str(&text);
            let diags = diagnose(&text, &rope_ref);
            self.publish(uri, diags);
        }

        pub fn did_change(&self, params: DidChangeTextDocumentParams) {
            let uri = params.text_document.uri.clone();
            let Some(mut entry) = self.docs.get_mut(&uri) else {
                return;
            };
            apply_changes(entry.value_mut(), &params.content_changes);
            let text = entry.to_string();
            drop(entry);

            let rope_ref = Rope::from_str(&text);
            let diags = diagnose(&text, &rope_ref);
            self.publish(uri, diags);
        }

        pub fn did_close(&self, params: DidCloseTextDocumentParams) {
            let uri = params.text_document.uri.clone();
            self.docs.remove(&uri);
            self.publish(uri, vec![]);
        }

        pub fn hover_at(&self, uri: &Url, pos: tower_lsp::lsp_types::Position) -> Option<Hover> {
            let rope = self.docs.get(uri)?;
            let (ident, range) = identifier_at(rope.value(), pos)?;
            let doc = verb_doc(&ident)?;
            Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: doc.to_string(),
                }),
                range: Some(range),
            })
        }

        pub fn complete_at(
            &self,
            uri: &Url,
            pos: tower_lsp::lsp_types::Position,
        ) -> Vec<CompletionItem> {
            let prefix = self
                .docs
                .get(uri)
                .and_then(|rope| identifier_at(rope.value(), pos).map(|(p, _)| p))
                .unwrap_or_default();

            verb_list()
                .into_iter()
                .filter(|v| prefix.is_empty() || v.starts_with(&prefix))
                .map(|v| CompletionItem {
                    label: v.to_string(),
                    kind: Some(CompletionItemKind::KEYWORD),
                    detail: Some("story verb".to_string()),
                    insert_text: Some(v.to_string()),
                    ..CompletionItem::default()
                })
                .collect()
        }
    }
}

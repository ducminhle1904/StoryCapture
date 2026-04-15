# Phase 3: Intelligence Layer — AI Authoring & Voiceover - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning
**Mode:** discuss (interactive, Vietnamese)

<domain>
## Phase Boundary

Thêm "lớp thông minh" lên trên pipeline Phase 1 + 2 để (a) non-developer có thể tác giả `.story` bằng tiếng tự nhiên, (b) thêm AI voiceover sync với DSL steps, (c) DSL author có LSP-powered editor + dry-run loop nhanh. Tất cả LLM/TTS keys lưu OS keychain.

**In scope:**
- NL → DSL chat (AI-01, UI-07): chat panel side-by-side editor, per-step diff card với approve/edit/regen/reject, conversation history per-project.
- AI voiceover (AI-02): TTS provider trait (ElevenLabs default, OpenAI fallback), bundled voice presets + browse provider catalog, LLM-generated auto-script per-step, hash-based audio cache.
- Voiceover ↔ timeline sync (AI-03): TTS clip snap vào DSL step boundary, **TTS làm ground truth → step duration co giãn theo TTS**, fill BGM auto-duck slot đã chuẩn bị Phase 2 D-22.
- Dry-Run mode (AI-04): chạy automation (chromiumoxide từ Phase 1) không capture/encode, inline gutter status real-time + summary panel, log selector fallback.
- API key keychain (AI-05): `tauri-plugin-keyring` cho LLM + TTS keys; không bao giờ persist plaintext trong project.sqlite, app.sqlite, hay log.
- LSP cho DSL editor (AI-06): in-process Rust LSP via `tower-lsp`, expose qua Tauri IPC, share `crates/story-parser` trực tiếp; diagnostic = grammar errors + semantic offline (undefined verb, sai args, selector heuristic warnings); inline gutter + hover popover cho selector fallback feedback.

**Out of scope (chuyển phase khác hoặc deferred):**
- Cloud sync conversation history, branded voice presets cấp org → Phase 4.
- Web companion ↔ desktop chat sync → Phase 4.
- Vision-based DSL gen từ screenshot, custom voice cloning, multi-language UI → v2.
- Live browser selector validation real-time trong LSP (chỉ on-demand qua dry-run).
- Hard cap budget per project, full LLM cost accounting → defer (chỉ soft warning Phase 3).
- LSP standalone binary để dùng ngoài app → defer.

</domain>

<decisions>
## Implementation Decisions

### LLM Strategy (NL → DSL)
- **D-01:** **Anthropic-first.** Default = Claude Sonnet 4.6 cho balance quality/cost; cho phép user override sang Opus 4.6 khi muốn chất lượng cao hơn. OpenAI (GPT-4o / 4.1) là **fallback** provider. Lý do: Claude mạnh structured output + code, prompt caching tiết kiệm token cho conversation dài.
- **D-02:** **Trait `LlmProvider` từ ngày đầu** trong `crates/intelligence` với 2 implementations (Anthropic + OpenAI). Pattern song song với `BrowserDriver` của Phase 1. Switch provider = swap impl, không refactor sau. **Không** dùng wrapper SDK pre-1.0 (rig/genai) — risk dependency drift.
- **D-03:** **Bật prompt caching + streaming mặc định.** Anthropic prompt caching cho system prompt + pest grammar + verb catalog (cache hit ~5× rẻ hơn input). SSE stream response để diff render xấp xỉ real-time. OpenAI adapter dùng tương đương (auto prompt caching + SSE).
- **D-04:** **Cost guardrail = soft warning + per-session token counter.** Hiển thị estimated cost (token × model price) trước call lớn (>50K input). Counter session token spend trong status bar bên cạnh user identity. **KHÔNG hard-block, KHÔNG per-project budget** trong Phase 3 (deferred).
- **D-05:** **Context gửi LLM mỗi turn:** system = pest grammar + verb catalog + DSL writing guide (cached); per-turn = full file `.story` hiện tại + conversation history. **KHÔNG** đính screenshot, DOM snapshot, hay accessibility tree (deferred — bypass v1 simplicity, đoán được cost).

### NL-Mode Chat UX (UI-07)
- **D-06:** **Layout = side panel phải.** Editor + per-step diff cards chiếm ~65%, chat panel phải ~35% có thể collapse. Match Cursor/Zed AI panel pattern. **KHÔNG** modal overlay, **KHÔNG** full-screen mode chuyên dụng (giữ DSL editor luôn nhìn được).
- **D-07:** **Diff preview = per-step block + inline diff.** Mỗi DSL step là 1 card; trong card hiện inline diff (red/green line). Mỗi card có button ✓ approve / ✎ edit / ↻ regenerate / ✕ reject **per-step**. Match Success Criteria #1.
- **D-08:** **Iterate flow = inline edit + send-back.** User edit text của step ngay trong card (mini-editor với grammar highlight) hoặc reply chat ("step 3 dùng selector khác"). LLM regen **chỉ step đó**, giữ nguyên steps khác (delta prompt với marker phân biệt).
- **D-09:** **Conversation history persist per-project trong `project.sqlite`.** Bảng mới: `nl_conversations(project_id, turn_index, role, content, tool_calls_json, created_at, llm_model, llm_provider, token_usage_json)`. Mở project lại = thấy lịch sử chat. Không auto-summarize trong Phase 3 (defer).

### TTS + Voiceover Sync (AI-02, AI-03)
- **D-10:** **Provider TTS = ElevenLabs first.** Default ElevenLabs (chất lượng voice cinematic, multi-language). OpenAI TTS là fallback (rẻ hơn, latency thấp). Trait `TtsProvider` analog với `LlmProvider` D-02.
- **D-11:** **Voice catalog = bundled curated set + browse provider catalog.** Ship 6-8 voice presets (StoryCapture-curated mapping → voice IDs cụ thể: "Energetic male", "Calm female", "Tutorial-narrator", v.v.). Nút "Browse all" mở provider catalog full. Preview button gọi TTS với sample text 1-2 câu.
- **D-12:** **Auto-script = LLM-generated từ DSL + step labels.** Re-use Anthropic provider (D-01) sinh narration script per-step. User edit per-step text trước khi commit gọi TTS — tránh waste tokens TTS cho script tệ.
- **D-13:** **Sync rule = step duration co giãn theo TTS (TTS là ground truth).** Khi TTS dài hơn step → kéo dài step (insert pause/freeze frame cuối step trước khi sang scene/transition kế). Khi ngắn hơn → giữ nguyên step duration + silence padding cuối. **KHÔNG** time-stretch TTS, **KHÔNG** overflow sang step kế. Match Success Criteria #2 ("snap to step boundaries").
- **D-14:** **TTS audio cache theo `hash(script + voice_id + provider + model)`.** Lưu .mp3 trong `{project}/voiceover/{step_id}-{hash}.mp3`. Script + voice không đổi → reuse, không gọi TTS lại. Đổi script = gen mới, giữ cache cũ 1 tuần rồi GC.
- **D-15:** **BGM auto-duck wiring:** Khi voiceover clip có audio trong phạm vi timeline → kích hoạt -12dB duck đã chuẩn bị Phase 2 D-22. Không thiết kế lại; chỉ feed event vào sound mixer.

### LSP Architecture (AI-06)
- **D-16:** **In-process Rust LSP với `tower-lsp`.** LSP chạy trong main Tauri process, expose request/response qua **Tauri command + Channel<T>** (KHÔNG stdio JSON-RPC sidecar). CodeMirror gửi request qua IPC bridge. Lý do: share `crates/story-parser` trực tiếp (không drift), latency thấp, không spawn process. Adapter LSP↔IPC viết trong `crates/intelligence/src/lsp/`.
- **D-17:** **Diagnostic scope = grammar + semantic offline.** Grammar errors (parse fail từ pest), undefined verb, sai số arg, unknown identifier, selector heuristic checks ("selector quá generic", "missing fallback"), step-order warnings. **KHÔNG** gọi browser live trong LSP — selector validation thật chỉ qua Dry-Run (D-19).
- **D-18:** **Smart-selector fallback feedback = inline gutter marker + hover popover.** Mỗi step có selector đã fallback ở run trước hiện icon ⚠️ ở gutter editor; hover ra popover "Selector chính fail → fallback strategy 2 thành công (450ms). Click để cập nhật selector". Match Success Criteria #3. KHÔNG dedicated panel (Claude's discretion phía dưới có thể bổ sung).

### Dry-Run (AI-04)
- **D-19:** **Dry-Run UX = inline per-step status + summary panel.** Khi dry-run chạy, gutter của mỗi step đổi màu real-time (queued/running/pass/fail/retry). Panel dưới editor tóm tắt thời gian per-step + selector fallback chain. Last-run results persist trong session memory (không persist sang reload). Re-use Phase 1 chromiumoxide BrowserDriver, skip capture + encode.

### API Keys (AI-05)
- **D-20:** **OS keychain qua `tauri-plugin-keyring`** cho cả LLM keys (Anthropic, OpenAI) + TTS keys (ElevenLabs, OpenAI). **Không bao giờ** ghi plaintext key vào project.sqlite, app.sqlite, log file, hay export. Key đọc on-demand mỗi call (cache trong process memory only). Match Success Criteria #5.

### Crate Layout
- **D-21:** **Crate mới `crates/intelligence`** chứa: `llm/` (trait + Anthropic + OpenAI impl), `tts/` (trait + ElevenLabs + OpenAI impl), `lsp/` (tower-lsp service + IPC adapter), `nl/` (NL→DSL prompt templates + diff engine), `dryrun/` (orchestrator re-using Phase 1 BrowserDriver). Cargo workspace member.

### State & IPC
- **D-22:** **Zustand** cho UI ephemeral state: chat panel scroll, current diff preview state, dry-run real-time gutter. **TanStack Query** cho IPC-cached: conversation list per-project, voice catalog, last dry-run summary. Match Phase 1 D-39 + Phase 2 D-32.
- **D-23:** **Long-running jobs (NL request, TTS generation, dry-run)** qua actor pattern + `Channel<T>` từ Phase 1 D-06 — cùng infra với render queue Phase 2 D-04. Không dựng IPC mới.

### Claude's Discretion
- **API key onboarding UX:** Settings → Accounts page chung cho cả LLM + TTS providers; prompt khi user gọi feature lần đầu mà chưa có key. Validate khi save bằng cheap test call (vd: list models / list voices). Global per provider, KHÔNG per-project. Missing-key state = banner với CTA "Add key in Settings".
- **Empty/error states cho NL Mode:** loading skeleton trong chat panel, retry button khi LLM fail, fallback message khi rate-limited, link "Switch provider" khi provider down.
- **Selector Health panel (bổ sung gutter):** nếu thiết kế UI thấy cần, có thể thêm panel bên dưới editor liệt kê tất cả selectors có warning/fallback — KHÔNG bắt buộc Phase 3, planner quyết định nếu effort thấp.
- **CodeMirror LSP plumbing:** chọn `@codemirror/lsp` adapter hoặc viết extension custom (planner research). Đã quyết transport (D-16) là Tauri IPC.
- **Telemetry off cho AI calls:** không gửi prompts/responses sang bất kỳ third party ngoài provider chính — match PROJECT.md no-telemetry-default.
- **Multi-language input:** default tiếng Anh; nếu user nhập tiếng khác, không filter — pass-through cho LLM. Voice catalog hiển thị flag/locale meta nếu provider expose.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project & roadmap
- `.planning/PROJECT.md` — Vision, constraints, stack commitments (no-telemetry default, OS keychain, native sidecar pattern).
- `.planning/REQUIREMENTS.md` — AI-01..06, UI-07 acceptance criteria.
- `.planning/ROADMAP.md` §"Phase 3" — Goal + Success Criteria #1..#5.

### Prior phase context (must obey carry-forward decisions)
- `.planning/phases/01-foundation-dsl-automation-capture-encode/01-CONTEXT.md` — `BrowserDriver` trait pattern (D-02), Channel<T> actor pattern (D-06), keychain plugin (D-?), CodeMirror baseline (D-34), Zustand+TanStack split (D-39), pest grammar location.
- `.planning/phases/02-cinematic-post-production-export/02-CONTEXT.md` — BGM auto-duck slot prepared (D-22), render queue actor pattern (D-04), Zustand+TanStack split (D-32).

### Library docs (researcher fetches via Context7 / WebFetch when planning)
- `tower-lsp` crate docs — in-process LSP server pattern.
- Anthropic API docs — prompt caching (`cache_control`), streaming SSE, tool-use for structured DSL output.
- OpenAI API docs — Chat Completions streaming, prompt caching auto, TTS endpoint.
- ElevenLabs API docs — voice catalog, TTS streaming, voice settings.
- `tauri-plugin-keyring` (HuakunShen) README — store/get/delete API.
- `@codemirror/lsp` or equivalent LSP client extension for CodeMirror 6.

[No bespoke specs/ADRs exist yet for Phase 3 — requirements above are fully captured in decisions D-01..D-23.]

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 1 + 2 plans, codebase is greenfield but stack committed)
- **`crates/story-parser`** (Phase 1) — pest grammar + AST. LSP **must** import this, not reimplement.
- **`BrowserDriver` trait + chromiumoxide impl** (Phase 1) — Dry-Run reuses end-to-end (skip capture/encode hooks).
- **`tauri-plugin-keyring`** (Phase 1) — same wiring pattern for LLM/TTS keys.
- **Channel<T> + actor queue** (Phase 1 D-06, Phase 2 D-04) — long-running LLM/TTS jobs reuse this; no new IPC primitive.
- **CodeMirror 6 editor** (Phase 1 D-34) — extension point for LSP client + per-step diff cards.
- **Zustand + TanStack Query split** (Phase 1 D-39, Phase 2 D-32) — Phase 3 inherits exactly.
- **`project.sqlite` + `rusqlite_migration`** (Phase 1 D-27, Phase 2 D-28) — add `nl_conversations`, `tts_cache_index` tables via new migration.
- **Sound mixer + auto-duck slot** (Phase 2 D-22) — TTS feeds event in, no redesign.

### Established Patterns (must follow)
- Trait-based provider abstractions (BrowserDriver style) — applied to LlmProvider (D-02) + TtsProvider (D-10).
- Static universal sidecars for binaries; LSP is **NOT** a sidecar (D-16 = in-process).
- No telemetry default; opt-in log upload only.

### Integration Points
- New crate `crates/intelligence` joins Cargo workspace.
- Tauri commands: `nl_chat_send`, `nl_diff_apply`, `tts_generate`, `tts_voice_list`, `lsp_request`, `dryrun_start`, `dryrun_cancel`, `key_set/get/test` (per provider).
- New SQLite migration adding `nl_conversations` + `tts_cache_index`.
- CodeMirror extensions: LSP client adapter + per-step diff card decoration.
- Settings → Accounts page (new) for API keys.

</code_context>

<specifics>
## Specific Ideas

- "Per-step approve/edit/regenerate/reject" must visibly map 1:1 với DSL step boundaries — không patch hunks lệch boundary.
- TTS cache key bao gồm `provider + model + voice_id + script_text` để bất kỳ thay đổi nào invalidate đúng.
- Selector fallback popover hiển thị **strategy nào thắng + thời gian fallback** để user quyết update selector chính.

</specifics>

<deferred>
## Deferred Ideas

- **Vision/screenshot context cho NL→DSL** — gửi screenshot URL đích để output selector chính xác hơn. Tốn cost + cần vision-capable model. Defer v2.
- **DOM/accessibility-tree context cho NL→DSL** — chạy chromiumoxide lấy a11y tree để LLM biết selector thật. Phức tạp + chậm. Defer v2.
- **Hard budget cap per-project + full cost accounting** trong project.sqlite. Defer post-Phase-3 sau khi đo usage thật.
- **Conversation auto-summarize** khi quá dài. Defer (Sonnet 4.6 context window đủ rộng cho v1).
- **Live browser selector validation real-time trong LSP**. Chỉ on-demand qua Dry-Run (D-19).
- **LSP standalone binary** để dùng ngoài app desktop (vd: VS Code extension cho `.story` files). Defer.
- **Custom voice cloning, brand voice presets cấp org**. Phase 4 / v2.
- **Cloud sync conversation history + voice caches** — Phase 4.
- **Multi-language UI**. v2 (input multi-language pass-through OK).
- **Dedicated "Selector Health" panel** ngoài inline gutter — Claude's discretion (planner quyết).

</deferred>

---

*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Context gathered: 2026-04-15*

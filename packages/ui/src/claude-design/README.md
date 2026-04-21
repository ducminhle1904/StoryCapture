# Claude Design — Raw Bundle

Reference copy of the stylesheet foundation from the Claude Design handoff
(`.planning/design/storycapture-claude-design/`). **Not yet wired into any app.**

- `tokens.css` — `--sc-*` tokens (neutral ramp, warm-amber accent, semantic record/success/warn/info, radii, density, shadows, platform-aware surfaces).
- `app.css` — window chrome, titlebar (macOS traffic lights + Windows caption buttons), side nav, toolbar, primitive styles (`.sc-btn`, `.sc-input`, `.sc-badge`, `.sc-slider`, `.sc-switch`, `.sc-card`, `.sc-kbd`).

The active token system lives in `../tokens.css` (Cursor-inspired warm minimalism). The next session must decide how to reconcile the two — merge into a single system or namespace `sc-*` alongside.

Full source (JSX screens, overlays, primitives) is at `.planning/design/storycapture-claude-design/project/`. Read `README.md` and `chats/chat1.md` there for intent.

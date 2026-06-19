# /simplify Handoff — Phase 12 + 13

> Historical planning note: this handoff predates the current Electron-only
> host and may mention removed Rust/Tauri paths. Use it only as historical
> context unless refreshed.

**Paused:** 2026-04-20 (context budget exhausted mid-task)
**Scope:** chạy `/simplify` trên toàn bộ code thay đổi ở Phase 12 và Phase 13.

## Để tiếp tục ở session mới

1. `cd /Users/locvotuan/git/StoryCapture`
2. Chạy lệnh sau để lấy full diff (đã verify đúng range):
   ```bash
   git diff 47f2c97..HEAD -- 'apps/**' 'crates/**' 'packages/**' 'docs/**'
   ```
   - Base commit: `47f2c97` (cha của commit đầu tiên Phase 12: `ba82962 docs(12): create phase plan`)
   - HEAD hiện tại: `3f19e38 chore(13): mark phase complete + STATE/ROADMAP updates`
   - Range gồm **32 commit** qua 2 phase.
3. Gọi `/simplify` — skill sẽ spawn 3 review agent song song (reuse / quality / efficiency) với full diff, rồi apply fix.

## Ghi chú thêm

- Phase 12 = backend Rust (crates/encoder filters, quality resolver, EncodeConfig refactor, IPC DTOs, real-ffmpeg tests).
- Phase 13 = toàn bộ frontend TS/React (shadcn Base UI primitives, output-prefs Zustand store, persist layer, VideoOutputSection, AdvancedOutputOptions accordion) + backend EncoderOptionsDto.
- Không có UAT hoặc verification gap còn lại — cả 2 phase đều verified PASS. Việc review này thuần tuý là cleanup.
- Test suite đang xanh: `cargo test --lib commands::export` (11/11), `pnpm --filter desktop vitest run` (26/28, 2 file fail ngoài scope 13: `nl-mode/ChatPanel.test.tsx`, `settings/AccountsPage.test.tsx`).

## Files candidates để ưu tiên nhìn kỹ

Theo kinh nghiệm trong quá trình merge:
- `apps/desktop/src/features/post-production/export-modal/advanced-output-options.tsx` (396 LOC, phức tạp nhất trong 13-05)
- `apps/desktop/src/features/post-production/export-modal/encoder-options-table.ts` (decision table — có thể đơn giản hoá)
- `apps/desktop/src/features/recorder/video-output/*` (11 component mới — check lại có đang nest JSX dư, duplicate copy strings không)
- `apps/desktop/src/state/output-prefs.ts` + `apps/desktop/src/lib/output-prefs-persist.ts` (check preset-matching có hàm trùng Zustand boilerplate không)
- `apps/desktop/src-tauri/src/commands/export.rs` (+281 dòng — check 6 sub-DTO có thể gọn hơn không)
- `crates/encoder/src/filters.rs` + `crates/encoder/src/quality.rs` (Phase 12 — 2 module mới)

## Tham khảo

- `.planning/phases/12-*/12-0N-SUMMARY.md` (5 file)
- `.planning/phases/13-*/13-0N-SUMMARY.md` (5 file)
- `.planning/phases/13-*/13-VERIFICATION.md` (bằng chứng file:line per requirement)

---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 20
checkpoint_type: human-verify
checkpoint_task: 3
completed_tasks: [1, 2]
status: awaiting-human-verify
---

# 03-20 RESUME: Awaiting Human Verification

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Settings -> Accounts page with 4 provider rows + keychain callout + test button | `597b191` | `AccountsPage.tsx`, `ApiKeyRow.tsx`, `AccountsPage.test.tsx` |
| 2 | Token counter + cost warning modal + AI disclosure modal | `93de823` | `TokenCounter.tsx`, `TokenBreakdownPopover.tsx`, `CostWarningModal.tsx`, `AiDisclosureModal.tsx`, `TokenCounter.test.tsx` |

## Tests

All 12 Vitest tests pass (6 from Task 1 + 6 from Task 2).

## Current Task

**Task 3:** Human-verify accessibility + copy + motion across full Phase-3 UI
**Status:** awaiting verification
**Blocked by:** Human visual/accessibility inspection required

## Checkpoint Details

Launch `pnpm --filter desktop tauri dev`. Then verify:

1. **Copywriting (Vietnamese tone):**
   - Chat panel empty state shows "Viet story bang loi" (exact match).
   - Voice catalog empty state "Chua ket noi provider TTS" appears when no ElevenLabs key.
   - Every destructive action uses exact copy from UI-SPEC destructive actions table.

2. **Color + accent (10% rule):**
   - Only the "Gui" CTA, "Chay thu" primary button, "Tao lai audio" generate, "Approve all" bulk, and streaming dot use the violet accent. Secondary buttons are muted/foreground.
   - Warning amber appears on token counter only when session > $1.00.

3. **Motion:**
   - Chat bubble enter 180ms easeOut (slide-up 8px).
   - Streaming dot pulses 900ms loop; halts to static when `prefers-reduced-motion`.
   - Diff card approve: 260ms border tint to success, then 400ms fade.

4. **Accessibility (keyboard-only pass):**
   - Tab through chat panel: composer -> diff cards (in order) -> action buttons. No focus trap unless in modal.
   - Cmd+1 focuses composer; Cmd+2 focuses editor. Voice catalog arrow key navigation.
   - Screen reader (VoiceOver): confirm `role="status" aria-live="polite"` announces "Dang sinh buoc {N}..." during streaming.
   - All icon-only buttons carry aria-label matching UI-SPEC.

5. **State coverage:**
   - Trigger network error (disconnect wifi), observe "Khong ket noi duoc toi {provider}" toast + retry CTA.
   - Trigger rate-limit (set test mock), observe banner with countdown.
   - Trigger auth-failed (invalid key in Settings), observe modal "API key {provider} khong hop le" + "Mo Settings" CTA.

## Awaiting

Type "approved" if all checkboxes pass, or list failing item(s) (e.g. "chat bubble motion wrong duration").

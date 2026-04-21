---
id: 260419-sr
title: "Stack review recommendation set"
created: 2026-04-19
status: captured
mode: quick
scope: lean
artifacts:
  - path: ".planning/quick/260419-sr-stack-review-recommendations/260419-sr-SUMMARY.md"
    provides: "Persisted follow-ups from the technical stack review"
---

<objective>
Persist the current stack-review follow-ups so they can be scheduled independently of the recording-engine work.
</objective>

## Recommendations

1. Add a real Tauri CSP in `src-tauri/tauri.conf.json` before shipping.
   - The current desktop config leaves `app.security.csp = null`.
   - Ship with a minimal CSP aligned to the actual Tauri asset/localhost/dev needs instead of carrying the permissive default into release builds.

2. Change browser bootstrap policy to system Chrome/Edge first and only download a bundled browser with explicit user consent.
   - The current automation path is Playwright-first and browser-heavy.
   - This better matches the desktop product constraints around installer size, update surface, notarization friction, and enterprise machine compatibility.

3. Finish the Base UI package migration to `@base-ui/react`.
   - The codebase still depends on `@base-ui-components/react`.
   - Keep the shadcn + Base UI direction, but move onto the maintained upstream package before more component surface area accumulates.

4. Update the architecture and stack docs to match the codebase's actual automation direction.
   - Planning and implementation are now explicitly Playwright-first, while the stack notes still describe `chromiumoxide` primary with Playwright fallback.
   - The docs should stop advertising a browser-automation split that the repo no longer intends to keep.

5. Put a planned Prisma 7 upgrade on the web-companion track.
   - The current web app runs on Prisma 6.17.x and is still viable.
   - Prisma 7 is the current major, so the repo should either pin Prisma 6 intentionally for a reason or schedule the upgrade before more schema/service code lands.

## Notes

- Saved directly under `.planning/quick/` because `AGENTS.md` references `/gsd-quick`, but that entrypoint is not installed in this shell environment.

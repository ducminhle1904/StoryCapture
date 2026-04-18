# Phase 7 Tier 1 — mixed new + legacy forms for the compile-only integration
# smoke in tests/tier1_e2e.rs. PHASE-7.3 live acceptance lives in the sidecar
# vitest (scripts/playwright-sidecar/server.test.mjs).
story "Tier 1 interop" {
  meta {
    app: "about:blank"
    viewport: 1280x800
  }
  scene "mixed" {
    click button "Save"
    fill field "Email" with "alice@example.com"
    click text "Learn more"
    click link "Docs"
    # Legacy forms — must coexist.
    click selector "img[alt='Hero']"
    click aria "Save"
  }
}

# Phase 7 Tier 1: legacy forms MUST keep parsing identically
story "Tier 1 legacy forms" {
  meta {
    app: "https://example.com"
  }
  scene "legacy" {
    click selector ".save-btn"
    click testid "save"
    click aria "Save"
    click "Save"
    type selector "#email" "alice@example.com"
  }
}

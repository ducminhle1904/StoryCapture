# Phase 7 Tier 1: new accessibility-first forms
story "Tier 1 new forms" {
  meta {
    app: "https://example.com"
    viewport: 1280x800
  }
  scene "new" {
    click button "Save"
    click link "Docs"
    click image "Dashboard preview"
    click img "Hero"
    fill field "Email" with "alice@example.com"
    click text "Learn more"
    hover button "Help"
  }
}

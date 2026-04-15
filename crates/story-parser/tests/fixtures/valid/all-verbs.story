story "All Verbs" {
  meta {
    app: "https://example.com"
    viewport: 1280x800
    theme: dark
    speed: 1.0
  }

  scene "every-verb" {
    navigate "https://example.com/start"
    click "Continue"
    type selector "#name" "Alice"
    scroll down 300
    hover testid "menu"
    drag aria "Card A" to aria "Slot B"
    select selector "#country" "USA"
    upload selector "input[type=file]" "/tmp/photo.png"
    wait 500ms
    wait-for "Loaded" timeout 5s
    assert "Welcome"
    screenshot "after-login"
    pause
  }
}

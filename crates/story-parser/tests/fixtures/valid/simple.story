story "Onboarding Flow" {
  meta {
    app: "https://app.example.com"
    viewport: 1280x800
    theme: dark
    speed: 1.0
  }

  scene "Login" {
    navigate "https://app.example.com/login"
    wait 1s
    type selector "#email" "user@example.com"
    click "Sign In"
    wait-for "Dashboard"
  }
}

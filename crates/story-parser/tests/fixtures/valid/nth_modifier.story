# Phase 11+ Fix #4: optional `nth N` postfix on targets.
# 1-indexed. Backward compat: targets without `nth` parse identically to
# pre-Fix-#4 behavior. Coverage: 4 verbs × 4 supported tiers + Drag.
story "nth modifier" {
  meta {
    app: "https://example.com"
  }
  scene "nth-aware" {
    click testid "row" nth 2
    click button "Save" nth 1
    click field "Email" nth 3
    click text "Learn more" nth 4
    hover testid "row" nth 2
    type field "Email" nth 1 "alice@example.com"
    select field "Country" nth 2 "VN"
    upload field "File" nth 1 "/tmp/x"
    wait-for testid "row" nth 5
    wait-for testid "row" nth 5 timeout 10s
    assert button "Save" nth 1
    drag testid "src" nth 1 to testid "dst" nth 2
    click testid "without-nth"
    click button "WithoutNth"
  }
}

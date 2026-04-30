// Phase 11-03 D-10 coverage — navigate-replay verb extraction for
// `picker_start_author` warm-up. Exercises `compute_navigate_urls` (pure
// helper over parsed story AST) and `replay_navigate_verbs` (best-effort
// dispatcher over the `AuthorPreviewControl` trait).
//
// Tests do NOT spawn a sidecar; `MockControl` records every invocation.

use std::sync::Arc;

use async_trait::async_trait;
use automation::PickElementResponse;
use storycapture::commands::picker::{
    compute_navigate_urls, replay_navigate_verbs, AuthorPreviewControl,
};
use storycapture::error::AppError;
use tokio::sync::Mutex as TokioMutex;

// Mock that records every author_navigate_to call and optionally fails
// them (for RN-4 — error isolation).
#[derive(Default)]
struct MockControl {
    navigated: TokioMutex<Vec<(String, String)>>,
    fail_nav_urls: TokioMutex<Vec<String>>,
    current_url: TokioMutex<String>,
}

#[async_trait]
impl AuthorPreviewControl for MockControl {
    async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<(), AppError> {
        self.navigated
            .lock()
            .await
            .push((stream_id.into(), url.into()));
        if self.fail_nav_urls.lock().await.iter().any(|u| u == url) {
            return Err(AppError::Automation(format!("forced fail: {url}")));
        }
        Ok(())
    }
    async fn pause_author_preview(&self, _stream_id: &str) -> Result<(), AppError> {
        Ok(())
    }
    async fn resume_author_preview(&self, _stream_id: &str) -> Result<(), AppError> {
        Ok(())
    }
    async fn pick_element_start_author(
        &self,
        _stream_id: &str,
        _timeout_ms: u64,
    ) -> Result<PickElementResponse, AppError> {
        unreachable!("not used in replay_navigate_verbs tests")
    }
    async fn author_current_url(&self, _stream_id: &str) -> Result<String, AppError> {
        Ok(self.current_url.lock().await.clone())
    }
}

// RN-1: three navigates on lines 4/6/12, cursor at 8 → emits first two.
#[test]
fn rn1_walks_up_to_cursor_line_inclusive() {
    // Line-by-line map:
    //   1: story "RN1" {
    //   2:   meta { app: "https://fallback.test" }
    //   3:   scene "s" {
    //   4:     navigate "https://a.test"       <- keep
    //   5:     click "Ok"
    //   6:     navigate "https://b.test"       <- keep
    //   7:     click "Ok"
    //   8:     click "Ok"                      <- cursor here
    //   9:     click "Ok"
    //  10:     click "Ok"
    //  11:     click "Ok"
    //  12:     navigate "https://c.test"       <- drop
    //  13:   }
    //  14: }
    let story = "\
story \"RN1\" {
  meta { app: \"https://fallback.test\" }
  scene \"s\" {
    navigate \"https://a.test\"
    click \"Ok\"
    navigate \"https://b.test\"
    click \"Ok\"
    click \"Ok\"
    click \"Ok\"
    click \"Ok\"
    click \"Ok\"
    navigate \"https://c.test\"
  }
}
";
    let urls = compute_navigate_urls(story, 8).expect("parse");
    assert_eq!(urls, vec!["https://a.test", "https://b.test"]);
}

// RN-2: zero navigates above cursor → fall back to meta.app.
#[test]
fn rn2_empty_navigates_fall_back_to_meta_app() {
    let story = "\
story \"RN2\" {
  meta { app: \"https://fallback.test\" }
  scene \"s\" {
    click \"Save\"
    click \"Cancel\"
  }
}
";
    let urls = compute_navigate_urls(story, 999).expect("parse");
    assert_eq!(urls, vec!["https://fallback.test"]);
}

// RN-3: mixed verbs → skips non-Navigate, preserves document order.
#[test]
fn rn3_skips_non_navigate_preserves_order() {
    let story = "\
story \"RN3\" {
  meta { app: \"https://x.test\" }
  scene \"mix\" {
    navigate \"https://first.test\"
    click \"Ok\"
    type selector \"#email\" \"a@b.c\"
    navigate \"https://second.test\"
    hover \"Open\"
  }
}
";
    let urls = compute_navigate_urls(story, 999).expect("parse");
    assert_eq!(urls, vec!["https://first.test", "https://second.test"]);
}

// RN-4: author_navigate_to errors are logged, not propagated — the walk
// completes for the remaining URLs (best-effort warm-up contract).
#[tokio::test]
async fn rn4_navigate_errors_do_not_abort_replay() {
    let story = "\
story \"RN4\" {
  meta { app: \"https://x.test\" }
  scene \"mix\" {
    navigate \"https://will-fail.test\"
    navigate \"https://ok.test\"
  }
}
";
    let mock = Arc::new(MockControl::default());
    mock.fail_nav_urls
        .lock()
        .await
        .push("https://will-fail.test".into());

    replay_navigate_verbs(mock.as_ref(), "s1", story, 999)
        .await
        .expect("replay itself returns Ok even when nav fails");

    let calls = mock.navigated.lock().await;
    assert_eq!(
        calls.len(),
        2,
        "both URLs attempted despite first failing; got {calls:?}"
    );
    assert_eq!(calls[0].1, "https://will-fail.test");
    assert_eq!(calls[1].1, "https://ok.test");
}

// RN-6: when the author page already sits on (or has browsed past) one of
// the script's nav URLs, replay must short-circuit so the user isn't
// teleported back to the start page when they click Picker mid-session.
#[tokio::test]
async fn rn6_skips_replay_when_current_url_supersedes_nav() {
    let story = "\
story \"RN6\" {
  meta { app: \"https://app.test\" }
  scene \"s\" {
    navigate \"https://app.test\"
    click \"Ok\"
  }
}
";
    let mock = Arc::new(MockControl::default());
    *mock.current_url.lock().await = "https://app.test/dashboard?tab=stats".into();

    replay_navigate_verbs(mock.as_ref(), "s1", story, 999)
        .await
        .expect("ok");

    let calls = mock.navigated.lock().await;
    assert!(
        calls.is_empty(),
        "expected no navigate calls when current URL supersedes script nav; got {calls:?}",
    );
}

// RN-7: cold start (about:blank) — replay must run.
#[tokio::test]
async fn rn7_replays_on_cold_start_about_blank() {
    let story = "\
story \"RN7\" {
  meta { app: \"https://app.test\" }
  scene \"s\" {
    navigate \"https://app.test\"
  }
}
";
    let mock = Arc::new(MockControl::default());
    *mock.current_url.lock().await = "about:blank".into();

    replay_navigate_verbs(mock.as_ref(), "s1", story, 999)
        .await
        .expect("ok");

    let calls = mock.navigated.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1, "https://app.test");
}

// RN-8: cross-site flows are common (login.example.com -> app.example.com,
// or www.wikipedia.org -> en.wikipedia.org). Same-site (shared registrable
// suffix) must skip replay; truly unrelated origins must replay.
#[tokio::test]
async fn rn8_same_site_subdomain_skips_unrelated_replays() {
    let story = "\
story \"RN8\" {
  meta { app: \"https://www.wikipedia.org\" }
  scene \"s\" {
    navigate \"https://www.wikipedia.org\"
  }
}
";
    let mock = Arc::new(MockControl::default());
    // Subdomain hop within the same site — must skip replay.
    *mock.current_url.lock().await = "https://en.wikipedia.org/wiki/Tauri_(software)".into();

    replay_navigate_verbs(mock.as_ref(), "s1", story, 999)
        .await
        .expect("ok");
    assert!(
        mock.navigated.lock().await.is_empty(),
        "subdomain en.wikipedia.org must be treated same-site as www.wikipedia.org",
    );

    // Unrelated host — must replay.
    let mock2 = Arc::new(MockControl::default());
    *mock2.current_url.lock().await = "https://example.com/anything".into();
    replay_navigate_verbs(mock2.as_ref(), "s1", story, 999)
        .await
        .expect("ok");
    assert_eq!(mock2.navigated.lock().await.len(), 1);
}

// RN-5: replay_navigate_verbs against MockControl invokes author_navigate_to
// in document order for each URL produced by compute_navigate_urls.
#[tokio::test]
async fn rn5_replay_invokes_control_per_url_in_order() {
    let story = "\
story \"RN5\" {
  meta { app: \"https://x.test\" }
  scene \"sequential\" {
    navigate \"https://one.test\"
    click \"Ok\"
    navigate \"https://two.test\"
  }
}
";
    let mock = Arc::new(MockControl::default());
    replay_navigate_verbs(mock.as_ref(), "abc", story, 999)
        .await
        .expect("ok");
    let calls = mock.navigated.lock().await;
    assert_eq!(
        calls.as_slice(),
        &[
            ("abc".into(), "https://one.test".into()),
            ("abc".into(), "https://two.test".into()),
        ]
    );
}

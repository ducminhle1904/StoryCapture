//! Integration tests for `OpenAiTtsProvider`.
//!
//! Covered behaviours (plan required 4; six delivered):
//! 1. `synthesize` POSTs the expected URL + body shape (model, input, voice,
//!    response_format=mp3, speed=1.0), with `Authorization: Bearer <key>`
//!    header, and returns the response bytes unchanged.
//! 2. `list_voices` returns exactly 6 `VoiceInfo` entries with `locale = "en"`
//!    and `premium = false` — static list, no network call issued.
//! 3. Invalid voice id (`"nonexistent"`) returns `VoiceNotFound("nonexistent")`
//!    via the local pre-validation guard BEFORE the network call (T-03-09-02).
//! 4. HTTP status mapping: 429 → RateLimited (with retry_after), 401 →
//!    AuthFailed, 402 → QuotaExceeded.

use intelligence::tts::openai_tts::{OpenAiTtsProvider, BUILTIN_VOICES};
use intelligence::tts::{TtsError, TtsProvider, TtsRequest};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sample_req_with_voice(voice: &str) -> TtsRequest {
    TtsRequest {
        model: "tts-1".into(),
        voice_id: voice.into(),
        text: "hello".into(),
        stability: None,
        similarity_boost: None,
    }
}

fn sample_req() -> TtsRequest {
    sample_req_with_voice("alloy")
}

#[tokio::test]
async fn synthesize_posts_audio_speech_and_returns_mp3_bytes() {
    let server = MockServer::start().await;
    let mp3_bytes: Vec<u8> = vec![0xFF, 0xFB, 0x90, 0x00, 0xAA, 0xBB, 0xCC, 0xDD];

    Mock::given(method("POST"))
        .and(path("/v1/audio/speech"))
        .and(header("authorization", "Bearer test-openai-key"))
        .and(header("content-type", "application/json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "audio/mpeg")
                .set_body_bytes(mp3_bytes.clone()),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = OpenAiTtsProvider::with_base_url("test-openai-key".into(), server.uri());
    let got = provider.synthesize(sample_req()).await.expect("synth ok");
    assert_eq!(got.as_ref(), mp3_bytes.as_slice());

    // Verify request body shape.
    let reqs = server.received_requests().await.expect("requests captured");
    assert_eq!(reqs.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).expect("json body");
    assert_eq!(body["model"], "tts-1");
    assert_eq!(body["input"], "hello");
    assert_eq!(body["voice"], "alloy");
    assert_eq!(body["response_format"], "mp3");
    assert_eq!(body["speed"], 1.0);
}

#[tokio::test]
async fn list_voices_returns_six_builtin_voices_without_network() {
    // No MockServer mounted here — if `list_voices` did a network call against
    // the default base_url it would fail. Use an obviously bogus base URL so
    // any accidental HTTP call surfaces immediately.
    let provider = OpenAiTtsProvider::with_base_url(
        "k".into(),
        "http://127.0.0.1:1/".into(), // unreachable — proves no network hit
    );
    let voices = provider.list_voices().await.expect("list ok");
    assert_eq!(voices.len(), 6, "expected exactly 6 built-in voices");
    for v in &voices {
        assert_eq!(v.locale.as_deref(), Some("en"));
        assert!(!v.premium);
        assert!(BUILTIN_VOICES.contains(&v.id.as_str()));
    }
    let names: Vec<&str> = voices.iter().map(|v| v.id.as_str()).collect();
    for expected in ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] {
        assert!(names.contains(&expected), "missing {}", expected);
    }
}

#[tokio::test]
async fn invalid_voice_returns_voice_not_found_before_network_call() {
    // No mock server because we expect zero network traffic — the whitelist
    // guard (T-03-09-02) must reject the voice before `.send()` is called.
    // We use an unreachable base URL so any accidental request fails loudly.
    let provider = OpenAiTtsProvider::with_base_url(
        "k".into(),
        "http://127.0.0.1:1/".into(),
    );
    let err = provider
        .synthesize(sample_req_with_voice("nonexistent"))
        .await
        .expect_err("whitelist guard should reject");
    match err {
        TtsError::VoiceNotFound(id) => assert_eq!(id, "nonexistent"),
        other => panic!("expected VoiceNotFound(\"nonexistent\"), got {:?}", other),
    }
}

#[tokio::test]
async fn http_429_maps_to_rate_limited_with_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/audio/speech"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "23")
                .set_body_string("rate limit hit"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = OpenAiTtsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    match err {
        TtsError::RateLimited { retry_after_s } => assert_eq!(retry_after_s, 23),
        other => panic!("expected RateLimited, got {:?}", other),
    }
}

#[tokio::test]
async fn http_401_maps_to_auth_failed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/audio/speech"))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
        .expect(1)
        .mount(&server)
        .await;

    let provider = OpenAiTtsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    assert!(matches!(err, TtsError::AuthFailed), "got {:?}", err);
}

#[tokio::test]
async fn http_402_maps_to_quota_exceeded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/audio/speech"))
        .respond_with(ResponseTemplate::new(402).set_body_string("over monthly quota"))
        .expect(1)
        .mount(&server)
        .await;

    let provider = OpenAiTtsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    assert!(matches!(err, TtsError::QuotaExceeded), "got {:?}", err);
}

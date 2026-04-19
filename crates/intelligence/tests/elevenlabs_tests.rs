//! Integration tests for `ElevenLabsProvider`.
//!
//! Five covered behaviours (plan required 4):
//! 1. `synthesize` POSTs the expected URL + body shape and returns the
//!    streamed MP3 bytes unchanged.
//! 2. `list_voices` parses the fixture into `Vec<VoiceInfo>` with ≥3 entries.
//! 3. `CURATED_PRESETS.len() >= 6` (D-11).
//! 4. HTTP status mapping: 429 → RateLimited, 401 → AuthFailed, 402 →
//!    QuotaExceeded, 404 → VoiceNotFound.
//! 5. `xi-api-key` header actually lands on the wire (defence-in-depth vs.
//!    accidental bearer-style leakage).

use std::path::PathBuf;

use intelligence::tts::elevenlabs::ElevenLabsProvider;
use intelligence::tts::voice_presets::CURATED_PRESETS;
use intelligence::tts::{TtsError, TtsProvider, TtsRequest};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("elevenlabs")
        .join(name)
}

fn voice_id() -> String {
    "EXAVITQu4vr4xnSDxMaL".to_string()
}

fn sample_req() -> TtsRequest {
    TtsRequest {
        model: "eleven_multilingual_v2".into(),
        voice_id: voice_id(),
        text: "Hello, world!".into(),
        stability: None,
        similarity_boost: None,
    }
}

#[tokio::test]
async fn synthesize_posts_streaming_endpoint_and_returns_mp3_bytes() {
    let server = MockServer::start().await;
    // Pretend-MP3 payload — the provider is content-agnostic.
    let mp3_bytes: Vec<u8> = vec![0xFF, 0xFB, 0x90, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF];

    Mock::given(method("POST"))
        .and(path(format!("/v1/text-to-speech/{}/stream", voice_id())))
        .and(header("xi-api-key", "test-elev-key"))
        .and(header("accept", "audio/mpeg"))
        .and(header("content-type", "application/json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "audio/mpeg")
                .set_body_bytes(mp3_bytes.clone()),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("test-elev-key".into(), server.uri());
    let got = provider.synthesize(sample_req()).await.expect("synth ok");
    assert_eq!(got.as_ref(), mp3_bytes.as_slice());

    // Verify request body shape.
    let reqs = server.received_requests().await.expect("requests captured");
    assert_eq!(reqs.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).expect("json body");
    assert_eq!(body["text"], "Hello, world!");
    assert_eq!(body["model_id"], "eleven_multilingual_v2");
    assert_eq!(body["voice_settings"]["stability"], 0.5);
    assert_eq!(body["voice_settings"]["similarity_boost"], 0.75);
    assert_eq!(body["voice_settings"]["style"], 0);
    assert_eq!(body["voice_settings"]["use_speaker_boost"], true);
}

#[tokio::test]
async fn list_voices_parses_catalog_fixture() {
    let server = MockServer::start().await;
    let body = std::fs::read_to_string(fixture_path("voices_list.json")).unwrap();
    Mock::given(method("GET"))
        .and(path("/v1/voices"))
        .and(header("xi-api-key", "test-elev-key"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_string(body),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("test-elev-key".into(), server.uri());
    let voices = provider.list_voices().await.expect("list ok");
    assert!(
        voices.len() >= 3,
        "expected ≥3 voices, got {}",
        voices.len()
    );
    let rachel = voices
        .iter()
        .find(|v| v.name == "Rachel")
        .expect("rachel present");
    assert_eq!(rachel.id, "21m00Tcm4TlvDq8ikWAM");
    assert_eq!(rachel.locale.as_deref(), Some("en"));
    assert!(!rachel.premium, "premade voices are not premium");
}

#[test]
fn curated_presets_meets_d11_minimum() {
    assert!(
        CURATED_PRESETS.len() >= 6,
        "D-11 requires ≥6 curated voice presets, got {}",
        CURATED_PRESETS.len()
    );
    assert!(
        CURATED_PRESETS.len() <= 8,
        "D-11 caps at 8 to avoid menu bloat"
    );
}

#[tokio::test]
async fn http_429_maps_to_rate_limited_with_retry_after() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/text-to-speech/{}/stream", voice_id())))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "17")
                .set_body_string("rate limit hit"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    match err {
        TtsError::RateLimited { retry_after_s } => assert_eq!(retry_after_s, 17),
        other => panic!("expected RateLimited, got {:?}", other),
    }
}

#[tokio::test]
async fn http_401_maps_to_auth_failed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/text-to-speech/{}/stream", voice_id())))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    assert!(matches!(err, TtsError::AuthFailed), "got {:?}", err);
}

#[tokio::test]
async fn http_402_maps_to_quota_exceeded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/text-to-speech/{}/stream", voice_id())))
        .respond_with(ResponseTemplate::new(402).set_body_string("over monthly quota"))
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    assert!(matches!(err, TtsError::QuotaExceeded), "got {:?}", err);
}

#[tokio::test]
async fn http_404_maps_to_voice_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/text-to-speech/{}/stream", voice_id())))
        .respond_with(ResponseTemplate::new(404).set_body_string("no such voice"))
        .expect(1)
        .mount(&server)
        .await;

    let provider = ElevenLabsProvider::with_base_url("k".into(), server.uri());
    let err = provider.synthesize(sample_req()).await.unwrap_err();
    match err {
        TtsError::VoiceNotFound(id) => assert_eq!(id, voice_id()),
        other => panic!("expected VoiceNotFound, got {:?}", other),
    }
}

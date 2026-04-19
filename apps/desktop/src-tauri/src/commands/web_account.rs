//! Web account OAuth + keychain storage commands.
//!
//! Five commands for desktop-to-web account linking:
//!
//! | Command                | Returns                           | Purpose                                  |
//! |------------------------|-----------------------------------|------------------------------------------|
//! | `start_web_oauth`      | `Result<u16, WebAccountError>`    | Spawn localhost callback server, open browser |
//! | `complete_web_oauth`   | `Result<WebAccountInfo, _>`       | Wait for callback, exchange + store token |
//! | `get_web_account`      | `Result<Option<WebAccountInfo>,_>`| Read account info from keychain          |
//! | `disconnect_web_account` | `Result<(), WebAccountError>`   | Remove token + info from keychain        |
//! | `get_web_api_token`    | `Result<Option<String>, _>`       | Read API token for upload/sync commands  |
//!
//! **Threat mitigations:**
//! - T-04-09 (Spoofing): Random port + 30s timeout + single-use localhost server
//! - T-04-10 (Info Disclosure): Token stored in OS keychain, never in SQLite or plaintext
//! - T-04-11 (DoS): 30-second timeout with clean shutdown

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// ---- public types --------------------------------------------------------

/// Information about a connected web account.
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebAccountInfo {
    pub email: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub connected_at: String, // ISO 8601
}

/// Structured error for web account operations.
#[derive(Serialize, Deserialize, Type, thiserror::Error, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum WebAccountError {
    #[error("OS keychain is unavailable")]
    KeychainUnavailable,
    #[error("no web account connected")]
    NotConnected,
    #[error("OAuth flow timed out after 30 seconds")]
    OAuthTimeout,
    #[error("failed to exchange token: {0}")]
    TokenExchangeFailed(String),
    #[error("network error: {0}")]
    NetworkError(String),
    #[error("failed to start OAuth server: {0}")]
    ServerError(String),
}

impl From<keyring::Error> for WebAccountError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => WebAccountError::NotConnected,
            _ => WebAccountError::KeychainUnavailable,
        }
    }
}

// ---- keychain constants --------------------------------------------------

const SERVICE: &str = "com.storycapture.web";
const ACCOUNT_TOKEN: &str = "web_api_token";
const ACCOUNT_INFO: &str = "web_account_info";

use super::util::web_url as web_companion_url;

// ---- Tauri commands -------------------------------------------------------

/// Start the OAuth flow: spawn a localhost callback server and open the
/// system browser to the web companion's GitHub OAuth page.
///
/// Returns the port number the callback server is listening on.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn start_web_oauth(app: tauri::AppHandle<tauri::Wry>) -> Result<u16, WebAccountError> {
    tracing::info!(target: "storycapture::web_account", "start_web_oauth");

    // Bind to a random available port on localhost.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| WebAccountError::ServerError(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| WebAccountError::ServerError(e.to_string()))?
        .port();

    // Create a oneshot channel so `complete_web_oauth` can receive the token.
    let (tx, rx) = oneshot::channel::<String>();
    let tx = Arc::new(tokio::sync::Mutex::new(Some(tx)));

    // Spawn the callback server in the background.
    tokio::spawn(async move {
        // Accept exactly one connection (single-use server).
        let timeout = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await;
        match timeout {
            Ok(Ok((mut stream, _addr))) => {
                // Read the HTTP request.
                let mut buf = vec![0u8; 4096];
                let n = match tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await {
                    Ok(n) => n,
                    Err(_) => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);

                // Extract the token from the callback URL query string.
                // Expected: GET /callback?token=<session_token> HTTP/1.1
                let token = extract_token_from_request(&request);

                // Send an HTML response to the browser.
                let (status, body) = if token.is_some() {
                    ("200 OK", "<html><body><h1>Authentication successful!</h1><p>You can close this window and return to StoryCapture.</p></body></html>")
                } else {
                    ("400 Bad Request", "<html><body><h1>Authentication failed</h1><p>No token received. Please try again.</p></body></html>")
                };

                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n{body}"
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, response.as_bytes()).await;
                let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream).await;

                // Send the token through the channel.
                if let Some(token) = token {
                    if let Some(sender) = tx.lock().await.take() {
                        let _ = sender.send(token);
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {
                // Accept failed or timed out — server shuts down.
            }
        }
    });

    // Store the receiver in Tauri managed state so `complete_web_oauth` can access it.
    let state = OAuthPendingState {
        rx: tokio::sync::Mutex::new(Some(rx)),
        port,
    };
    app.manage(state);

    // Open the system browser to the OAuth URL.
    let base = web_companion_url();
    let oauth_url =
        format!("{base}/api/auth/signin/github?callbackUrl=http://localhost:{port}/callback");
    tracing::info!(target: "storycapture::web_account", url = %oauth_url, "opening browser for OAuth");

    // Use tauri-plugin-opener to open the URL in the system browser.
    app.opener()
        .open_url(&oauth_url, None::<&str>)
        .map_err(|e| WebAccountError::ServerError(format!("failed to open browser: {e}")))?;

    Ok(port)
}

/// Wait for the OAuth callback, exchange the session token for an API token,
/// and store both in the OS keychain.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn complete_web_oauth(
    app: tauri::AppHandle<tauri::Wry>,
) -> Result<WebAccountInfo, WebAccountError> {
    tracing::info!(target: "storycapture::web_account", "complete_web_oauth: waiting for callback");

    // Retrieve the pending OAuth state.
    let state = app.try_state::<OAuthPendingState>().ok_or_else(|| {
        WebAccountError::ServerError("no pending OAuth flow — call start_web_oauth first".into())
    })?;

    // Wait for the callback with a 30-second timeout.
    let rx =
        state.rx.lock().await.take().ok_or_else(|| {
            WebAccountError::ServerError("OAuth callback already consumed".into())
        })?;

    let session_token = tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| WebAccountError::OAuthTimeout)?
        .map_err(|_| WebAccountError::ServerError("callback channel dropped".into()))?;

    // Exchange the session token for a long-lived API token by calling
    // the web companion's desktop-token endpoint.
    let base = web_companion_url();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| WebAccountError::NetworkError(e.to_string()))?;

    let resp = client
        .post(format!("{base}/api/auth/desktop-token"))
        .header("Authorization", format!("Bearer {session_token}"))
        .send()
        .await
        .map_err(|e| WebAccountError::NetworkError(e.without_url().to_string()))?;

    if !resp.status().is_success() {
        return Err(WebAccountError::TokenExchangeFailed(format!(
            "server returned {}",
            resp.status()
        )));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TokenResponse {
        token: String,
        email: String,
        name: Option<String>,
        avatar_url: Option<String>,
    }

    let token_resp: TokenResponse = resp
        .json()
        .await
        .map_err(|e| WebAccountError::TokenExchangeFailed(e.to_string()))?;

    // Store the API token in keychain (T-04-10: never in SQLite or plaintext).
    let token_entry = keyring::Entry::new(SERVICE, ACCOUNT_TOKEN).map_err(WebAccountError::from)?;
    token_entry
        .set_password(&token_resp.token)
        .map_err(WebAccountError::from)?;

    // Build and store account info.
    let now = time::OffsetDateTime::now_utc();
    let connected_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string());

    let account_info = WebAccountInfo {
        email: token_resp.email,
        name: token_resp.name,
        avatar_url: token_resp.avatar_url,
        connected_at,
    };

    let info_json = serde_json::to_string(&account_info)
        .map_err(|e| WebAccountError::TokenExchangeFailed(e.to_string()))?;
    let info_entry = keyring::Entry::new(SERVICE, ACCOUNT_INFO).map_err(WebAccountError::from)?;
    info_entry
        .set_password(&info_json)
        .map_err(WebAccountError::from)?;

    tracing::info!(
        target: "storycapture::web_account",
        email = %account_info.email,
        "web account connected"
    );

    Ok(account_info)
}

/// Read the connected web account info from keychain.
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn get_web_account() -> Result<Option<WebAccountInfo>, WebAccountError> {
    tracing::debug!(target: "storycapture::web_account", "get_web_account");

    let entry = match keyring::Entry::new(SERVICE, ACCOUNT_INFO) {
        Ok(e) => e,
        Err(_) => return Err(WebAccountError::KeychainUnavailable),
    };

    match entry.get_password() {
        Ok(json) => {
            let info: WebAccountInfo = serde_json::from_str(&json).map_err(|e| {
                WebAccountError::TokenExchangeFailed(format!("corrupt account info: {e}"))
            })?;
            Ok(Some(info))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(WebAccountError::from(e)),
    }
}

/// Remove all web account data from keychain.
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn disconnect_web_account() -> Result<(), WebAccountError> {
    tracing::info!(target: "storycapture::web_account", "disconnect_web_account");

    // Delete both entries; ignore NoEntry errors (already disconnected).
    for account in [ACCOUNT_TOKEN, ACCOUNT_INFO] {
        if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(WebAccountError::from(e)),
            }
        }
    }

    Ok(())
}

/// Read the API token from keychain (used by upload + sync commands).
#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub async fn get_web_api_token() -> Result<Option<String>, WebAccountError> {
    tracing::debug!(target: "storycapture::web_account", "get_web_api_token");

    let entry = match keyring::Entry::new(SERVICE, ACCOUNT_TOKEN) {
        Ok(e) => e,
        Err(_) => return Err(WebAccountError::KeychainUnavailable),
    };

    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(WebAccountError::from(e)),
    }
}

// ---- internal helpers ----------------------------------------------------

/// Managed state for the pending OAuth flow. Holds the oneshot receiver
/// that will deliver the session token from the localhost callback server.
struct OAuthPendingState {
    rx: tokio::sync::Mutex<Option<oneshot::Receiver<String>>>,
    #[allow(dead_code)]
    port: u16,
}

/// Extract the `token` query parameter from an HTTP GET request line.
///
/// Expected format: `GET /callback?token=<value> HTTP/1.1`
fn extract_token_from_request(request: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;

    // Parse query string from the path.
    let query = path.split('?').nth(1)?;
    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
            if key == "token" {
                // URL-decode the value (basic: just handle %XX).
                return Some(url_decode(value));
            }
        }
    }
    None
}

/// Basic URL decoding for the token value.
fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_token_from_valid_request() {
        let req = "GET /callback?token=abc123xyz HTTP/1.1\r\nHost: localhost:12345\r\n\r\n";
        assert_eq!(extract_token_from_request(req), Some("abc123xyz".into()));
    }

    #[test]
    fn extract_token_with_extra_params() {
        let req = "GET /callback?state=foo&token=mytoken&extra=bar HTTP/1.1\r\n\r\n";
        assert_eq!(extract_token_from_request(req), Some("mytoken".into()));
    }

    #[test]
    fn extract_token_missing() {
        let req = "GET /callback?state=foo HTTP/1.1\r\n\r\n";
        assert_eq!(extract_token_from_request(req), None);
    }

    #[test]
    fn extract_token_no_query() {
        let req = "GET /callback HTTP/1.1\r\n\r\n";
        assert_eq!(extract_token_from_request(req), None);
    }

    #[test]
    fn url_decode_basic() {
        assert_eq!(url_decode("hello%20world"), "hello world");
        assert_eq!(url_decode("a+b"), "a b");
        assert_eq!(url_decode("no%2fslash"), "no/slash");
    }
}

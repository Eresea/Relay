//! The Google OAuth "installed application" handshake: PKCE, a one-shot
//! local HTTP listener on a loopback port, and CSRF protection via `state`.
//!
//! This follows Google's documented flow for desktop apps (and RFC 8252):
//! there is no way to embed a client secret confidentially in a distributed
//! binary, so the client id is treated as public and PKCE (RFC 7636) carries
//! the actual proof that the app completing the token exchange is the same
//! one that started the authorization request. Google's "Desktop app" OAuth
//! client type accepts a loopback redirect at any port without
//! pre-registering it, which is what makes binding an ephemeral port here
//! workable — nothing needs to be reserved ahead of time.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use crate::error::{Error, Result};
use crate::gmail::api::SCOPE;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// A fresh code verifier (RFC 7636 recommends 43-128 characters; 32 random
/// bytes base64url-encode to 43) and its S256 challenge.
pub fn generate_pkce() -> Pkce {
    let mut verifier_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut verifier_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce {
        verifier,
        challenge,
    }
}

/// A random CSRF token echoed back on the loopback callback and checked
/// against what was sent — the standard defence against another local
/// process racing to complete the redirect first.
pub fn generate_state() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, pkce: &Pkce) -> String {
    let mut url = url::Url::parse(AUTH_ENDPOINT).expect("static endpoint is a valid URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        // Requests a refresh token, and `prompt=consent` forces Google to
        // reissue one even on a re-connect after a prior disconnect — without
        // it, a second consent for an app already granted access returns no
        // refresh_token at all.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.to_string()
}

/// Binds an OS-assigned loopback port and returns it with the listener bound
/// to it — split from `accept_callback` so the caller can build the redirect
/// URI and open the browser before blocking on the one connection Google's
/// redirect will make.
pub async fn bind_loopback() -> Result<(u16, TcpListener)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((port, listener))
}

/// Waits for the single browser redirect, validates `state`, and returns the
/// authorization code. Written to a real socket rather than mocked, since a
/// loopback listener is cheap to spin up in a test and this is the one place
/// a hand-rolled HTTP response could get the wire format wrong.
pub async fn accept_callback(listener: TcpListener, expected_state: &str) -> Result<String> {
    let (mut stream, _) = listener.accept().await?;
    let request_line = read_request_line(&mut stream).await?;
    let result = parse_callback(&request_line, expected_state);
    write_response(&mut stream, result.is_ok()).await;
    result
}

async fn read_request_line(stream: &mut TcpStream) -> Result<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    Ok(line)
}

async fn write_response(stream: &mut TcpStream, ok: bool) {
    let body = if ok {
        "<html><body>Relay is connected to Gmail. You can close this window.</body></html>"
    } else {
        "<html><body>Gmail sign-in did not complete. You can close this window and try again in Relay.</body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // Best-effort: the browser tab has what it needs (the notification the
    // OAuth flow completed) whether or not this write lands, and the caller
    // already has the parsed result either way.
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Pure parsing of the callback's request line, e.g.
/// `GET /callback?code=abc&state=xyz HTTP/1.1`, so the CSRF check and the
/// "Google reported an error" path are unit-testable with no socket at all.
fn parse_callback(request_line: &str, expected_state: &str) -> Result<String> {
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| Error::GmailAuthFailed("malformed callback request".into()))?;
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();

    if let Some(error) = params.get("error") {
        return Err(Error::GmailAuthFailed(error.clone()));
    }
    let state = params
        .get("state")
        .ok_or_else(|| Error::GmailAuthFailed("callback missing state".into()))?;
    if state != expected_state {
        return Err(Error::GmailStateMismatch);
    }
    params
        .get("code")
        .cloned()
        .ok_or_else(|| Error::GmailAuthFailed("callback missing code".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn pkce_challenge_is_the_sha256_of_the_verifier() {
        let pkce = generate_pkce();
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
    }

    #[test]
    fn two_pkce_pairs_are_never_the_same() {
        let a = generate_pkce();
        let b = generate_pkce();
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn authorize_url_carries_pkce_and_state() {
        let pkce = generate_pkce();
        let url = authorize_url(
            "client-123",
            "http://127.0.0.1:9999/callback",
            "state-abc",
            &pkce,
        );
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("state=state-abc"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("code_challenge={}", pkce.challenge)));
        assert!(url.contains("gmail.metadata"));
    }

    #[test]
    fn callback_parses_a_valid_redirect() {
        let code = parse_callback(
            "GET /callback?code=auth-code-1&state=expected HTTP/1.1\r\n",
            "expected",
        )
        .unwrap();
        assert_eq!(code, "auth-code-1");
    }

    #[test]
    fn callback_rejects_a_mismatched_state() {
        let result = parse_callback(
            "GET /callback?code=auth-code-1&state=wrong HTTP/1.1\r\n",
            "expected",
        );
        assert!(matches!(result, Err(Error::GmailStateMismatch)));
    }

    #[test]
    fn callback_surfaces_googles_own_error_param() {
        let result = parse_callback(
            "GET /callback?error=access_denied&state=expected HTTP/1.1\r\n",
            "expected",
        );
        assert!(matches!(result, Err(Error::GmailAuthFailed(msg)) if msg == "access_denied"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn accept_callback_round_trips_over_a_real_loopback_socket() {
        let (port, listener) = bind_loopback().await.unwrap();

        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream
                .write_all(
                    b"GET /callback?code=real-code&state=s1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                )
                .await
                .unwrap();
            let mut buf = Vec::new();
            stream.read_to_end(&mut buf).await.unwrap();
            String::from_utf8(buf).unwrap()
        });

        let code = accept_callback(listener, "s1").await.unwrap();
        assert_eq!(code, "real-code");

        let response = client.await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("connected to Gmail"));
    }
}

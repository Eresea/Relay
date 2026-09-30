//! Tauri-agnostic demo: prints the sign-in URL, you paste the `relay://auth/callback?...` URL back.
//!
//!   NEXUS_ISSUER=https://nexus.eresea.net/api/v1 NEXUS_CLIENT_ID=relay \
//!   NEXUS_REDIRECT_URI=relay://auth/callback cargo run --example cli

use std::io::{BufRead, Write};

use nexus_client::{AuthState, NexusClient, NexusConfig};

fn var(k: &str, default: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = NexusConfig {
        issuer: var("NEXUS_ISSUER", "https://nexus.eresea.net/api/v1"),
        client_id: var("NEXUS_CLIENT_ID", "relay"),
        redirect_uri: var("NEXUS_REDIRECT_URI", "relay://auth/callback"),
        scopes: var("NEXUS_SCOPES", "openid profile email connections")
            .split_whitespace()
            .map(String::from)
            .collect(),
        keyring_service: "nexus-client-cli".into(),
        keyring_account: "oauth-session".into(),
    };
    let client = NexusClient::with_keyring(config)?;

    if client.auth_state() == AuthState::SignedOut {
        client.sign_in(|url| {
            println!("Open this URL in your browser:\n\n{url}\n");
            Ok(())
        })?;
        print!("Paste the callback URL: ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        client.handle_callback(line.trim()).await?;
    }

    println!("signed in as {:?}", client.user().await?);
    println!(
        "granted connections: {}",
        client.connections().granted().await?.len()
    );

    println!("listening for events (ctrl-c to quit; `signout` + enter to sign out)...");
    let _events = client.events(|ev| async move {
        println!("event #{} {} {}", ev.seq, ev.event_type, ev.payload);
        Ok::<_, std::convert::Infallible>(())
    });
    let mut auth = client.watch();
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    let mut buf = String::new();
    loop {
        buf.clear();
        tokio::select! {
            _ = auth.changed() => {
                if *auth.borrow() == AuthState::SignedOut {
                    println!("signed out");
                    return Ok(());
                }
            }
            n = tokio::io::AsyncBufReadExt::read_line(&mut stdin, &mut buf) => {
                if n? == 0 { return Ok(()); }
                if buf.trim() == "signout" {
                    client.sign_out(false).await?;
                }
            }
        }
    }
}

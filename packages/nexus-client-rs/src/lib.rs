//! Nexus client for Tauri / native apps: OAuth authorization code + PKCE with keychain-backed
//! refresh tokens, a session-bound WebSocket with inbox delivery, connections (vault), event
//! endpoints and push registration. Tauri-agnostic: the browser is opened via caller callbacks.

mod client;
mod config;
mod error;
mod events;
mod inbox;
mod pkce;
mod rest;
mod store;

pub use client::{AuthState, NexusClient, PendingSignIn};
pub use config::NexusConfig;
pub use error::{BoxError, Error, Result};
pub use events::{ConnectionState, EventsHandle, EventsOptions};
pub use inbox::InboxEvent;
pub use rest::{
    AvailableCredential, Connections, Creator, Credential, CredentialInput, EndpointSecret,
    EventEndpoint, EventEndpointInput, EventEndpoints, GrantRequest, Push, Secret,
};
pub use store::{KeyringTokenStore, MemoryTokenStore, StoredSession, TokenStore, User};

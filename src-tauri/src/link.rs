//! Phone link: the phone asks, this PC acts, and Nexus only carries the mail.
//!
//! Nexus is deliberately not trusted here. An account takeover or a hostile
//! server must not be able to drive this machine, so being signed in grants
//! nothing:
//!
//! - **Pairing** is an X25519 exchange authenticated by a one-time code the
//!   PC shows and you type on the phone. Nexus carries the exchange but never
//!   sees the code, so it cannot get in the middle.
//! - **Messages** are AES-256-GCM under the resulting key, known only to the
//!   two devices: Nexus can neither read nor forge them. Each request expires
//!   and runs once, because the inbox redelivers and holds mail while the PC
//!   is offline.
//! - **Actions** are the one `match` in `run_action`. There is no way to send
//!   a program or a shell command; the code that runs them is not even
//!   compiled into the phone.
//!
//! Transport is one Nexus event endpoint shared by the account's installations
//! (its signing secret is kept as a connection). Everyone receives everything;
//! messages for someone else are skipped.
//!
//! ponytail: the key is a file readable by this app, so a phone unlocked by a
//! thief can ask too. That is acceptable while every action is read-only. An
//! action that changes anything needs the key in Android Keystore behind
//! biometrics first.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use nexus_client::{CredentialInput, EventEndpointInput, InboxEvent};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use x25519_dalek::{EphemeralSecret, PublicKey};

use crate::error::{Error, Result};
use crate::{modules, nexus_auth};

const MODULE: &str = "link";
const NAMESPACE: &str = "relay-link";
const CREDENTIAL_TYPE: &str = "event-channel";
const EVENT_PREFIX: &str = "relay.link.";
const EVENT_PAIR_REQUEST: &str = "relay.link.pair-request";
const EVENT_PAIR_RESPONSE: &str = "relay.link.pair-response";
const EVENT_SEALED: &str = "relay.link.sealed";
const FILE: &str = "link.json";
const ACTION_PROCESSES: &str = "processes.list";

/// How long a request stays valid after the phone sends it.
#[cfg(mobile)]
const REQUEST_TTL_SECS: u64 = 60;
/// A request claiming to live longer than this is refused: a wrong clock on
/// the phone must not make requests valid for hours.
#[cfg(any(desktop, test))]
const MAX_REQUEST_AHEAD_SECS: u64 = 120;
#[cfg(desktop)]
const PAIRING_TTL_SECS: u64 = 300;
/// Wrong codes before a pairing is called off. With 50-bit codes this is far
/// more than a typo needs and far too few to guess with.
#[cfg(desktop)]
const PAIRING_ATTEMPTS: u8 = 5;
#[cfg(mobile)]
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);

type Key = [u8; 32];

fn link_error(message: impl std::fmt::Display) -> Error {
    Error::Link(message.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---- The protocol. Pure, so the tests can play both sides and the attacker. ----

/// Crockford Base32, which has no letters that read like digits.
#[cfg(any(desktop, test))]
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
#[cfg(any(desktop, test))]
const CODE_LEN: usize = 10;

/// 50 random bits. It lives for minutes at most, so that is enough even
/// against someone recording the exchange and guessing offline.
#[cfg(any(desktop, test))]
fn new_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| char::from(CODE_ALPHABET[usize::from(byte & 31)]))
        .collect()
}

/// What you typed, as it was shown: case, spaces and dashes do not matter, and
/// the look-alikes Crockford leaves out read as the digits they resemble.
#[cfg(any(mobile, test))]
fn normalize_code(typed: &str) -> String {
    typed
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect()
}

/// Length-prefixed, so no two field lists can produce the same bytes.
fn transcript(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part);
    }
    out
}

fn code_mac(code: &str, parts: &[&[u8]]) -> Hmac<Sha256> {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(code.as_bytes()).expect("HMAC takes any key");
    mac.update(&transcript(parts));
    mac
}

fn request_mac(code: &str, id: &str, device_id: &str, name: &str, public: &[u8]) -> Hmac<Sha256> {
    code_mac(
        code,
        &[
            b"relay-link-v1 request",
            id.as_bytes(),
            device_id.as_bytes(),
            name.as_bytes(),
            public,
        ],
    )
}

fn response_mac(
    code: &str,
    request_id: &str,
    device_id: &str,
    name: &str,
    public: &[u8],
    phone_public: &[u8],
) -> Hmac<Sha256> {
    code_mac(
        code,
        &[
            b"relay-link-v1 response",
            request_id.as_bytes(),
            device_id.as_bytes(),
            name.as_bytes(),
            public,
            phone_public,
        ],
    )
}

fn public_key(encoded: &str) -> Option<[u8; 32]> {
    BASE64.decode(encoded).ok()?.try_into().ok()
}

fn valid_identity(device_id: &str, name: &str) -> bool {
    !device_id.is_empty() && device_id.len() <= 64 && !name.is_empty() && name.chars().count() <= 64
}

/// `None` for a low-order public key, which would fix the shared secret no
/// matter what our own key is.
fn shared_key(
    secret: EphemeralSecret,
    theirs: [u8; 32],
    code: &str,
    phone_public: &[u8],
    desktop_public: &[u8],
) -> Option<Key> {
    let shared = secret.diffie_hellman(&PublicKey::from(theirs));
    if !shared.was_contributory() {
        return None;
    }
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(code.as_bytes()), shared.as_bytes())
        .expand(
            &transcript(&[b"relay-link-v1 key", phone_public, desktop_public]),
            &mut key,
        )
        .ok()?;
    Some(key)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    id: String,
    device_id: String,
    name: String,
    public_key: String,
    mac: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    request_id: String,
    device_id: String,
    name: String,
    public_key: String,
    mac: String,
}

/// A device this one is paired with. `key` never leaves this device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    key: String,
    paired_at: u64,
}

impl Device {
    fn new(id: String, name: String, key: &Key) -> Self {
        Self {
            id,
            name,
            key: BASE64.encode(key),
            paired_at: now_secs(),
        }
    }

    fn key(&self) -> Result<Key> {
        BASE64
            .decode(&self.key)
            .ok()
            .and_then(|key| key.try_into().ok())
            .ok_or_else(|| link_error("the stored pairing is damaged; pair again"))
    }
}

#[cfg(any(mobile, test))]
fn new_pair_request(
    code: &str,
    device_id: &str,
    name: &str,
) -> (PairRequest, EphemeralSecret, [u8; 32]) {
    let secret = EphemeralSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret).to_bytes();
    let id = random_id();
    let mac = request_mac(code, &id, device_id, name, &public)
        .finalize()
        .into_bytes();
    let request = PairRequest {
        id,
        device_id: device_id.to_owned(),
        name: name.to_owned(),
        public_key: BASE64.encode(public),
        mac: BASE64.encode(mac),
    };
    (request, secret, public)
}

/// The PC's side: `None` unless the phone knows the code.
#[cfg(any(desktop, test))]
fn accept_pair_request(
    code: &str,
    request: &PairRequest,
    device_id: &str,
    name: &str,
) -> Option<(Device, PairResponse)> {
    if !valid_identity(&request.device_id, &request.name) {
        return None;
    }
    let phone_public = public_key(&request.public_key)?;
    request_mac(
        code,
        &request.id,
        &request.device_id,
        &request.name,
        &phone_public,
    )
    .verify_slice(&BASE64.decode(&request.mac).ok()?)
    .ok()?;

    let secret = EphemeralSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret).to_bytes();
    let key = shared_key(secret, phone_public, code, &phone_public, &public)?;
    let mac = response_mac(code, &request.id, device_id, name, &public, &phone_public)
        .finalize()
        .into_bytes();
    let response = PairResponse {
        request_id: request.id.clone(),
        device_id: device_id.to_owned(),
        name: name.to_owned(),
        public_key: BASE64.encode(public),
        mac: BASE64.encode(mac),
    };
    let device = Device::new(request.device_id.clone(), request.name.clone(), &key);
    Some((device, response))
}

/// The phone's side: `None` unless the answer really came from the code's PC.
#[cfg(any(mobile, test))]
fn finish_pairing(
    code: &str,
    secret: EphemeralSecret,
    phone_public: &[u8; 32],
    request_id: &str,
    response: &PairResponse,
) -> Option<Device> {
    if response.request_id != request_id || !valid_identity(&response.device_id, &response.name) {
        return None;
    }
    let public = public_key(&response.public_key)?;
    response_mac(
        code,
        request_id,
        &response.device_id,
        &response.name,
        &public,
        phone_public,
    )
    .verify_slice(&BASE64.decode(&response.mac).ok()?)
    .ok()?;
    let key = shared_key(secret, public, code, phone_public, &public)?;
    Some(Device::new(
        response.device_id.clone(),
        response.name.clone(),
        &key,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    from: String,
    to: String,
    nonce: String,
    ciphertext: String,
}

fn seal(key: &Key, from: &str, to: &str, plain: &[u8]) -> Result<Envelope> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = transcript(&[b"relay-link-v1 sealed", from.as_bytes(), to.as_bytes()]);
    let ciphertext = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &aad,
            },
        )
        .map_err(|_| link_error("could not encrypt the message"))?;
    Ok(Envelope {
        from: from.to_owned(),
        to: to.to_owned(),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// `None` unless the holder of `key` sent exactly this, from and to these
/// devices. Binding both ends is what stops a request being reflected back.
fn open(key: &Key, envelope: &Envelope) -> Option<Vec<u8>> {
    let nonce: [u8; 12] = BASE64.decode(&envelope.nonce).ok()?.try_into().ok()?;
    let ciphertext = BASE64.decode(&envelope.ciphertext).ok()?;
    let aad = transcript(&[
        b"relay-link-v1 sealed",
        envelope.from.as_bytes(),
        envelope.to.as_bytes(),
    ]);
    Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .ok()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    expires_at: u64,
    action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Process {
    pid: u32,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    processes: Option<Vec<Process>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(any(desktop, test))]
#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Fresh,
    Expired,
    Replayed,
}

/// Decides whether a request that opened correctly may run, remembering it so
/// a redelivery cannot run it twice. Ids are forgotten once they expire, since
/// from then on the expiry refuses them anyway.
#[cfg(any(desktop, test))]
fn admit(seen: &mut HashMap<String, u64>, request: &Request, now: u64) -> Admission {
    seen.retain(|_, expires_at| *expires_at >= now);
    if seen.contains_key(&request.id) {
        return Admission::Replayed;
    }
    if request.expires_at < now || request.expires_at > now + MAX_REQUEST_AHEAD_SECS {
        return Admission::Expired;
    }
    seen.insert(request.id.clone(), request.expires_at);
    Admission::Fresh
}

/// The Nexus ingress signature (`X-Nexus-Signature`).
fn ingress_signature(
    key: &[u8],
    timestamp: &str,
    delivery_id: &str,
    event_type: &str,
    body: &[u8],
) -> Result<String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(link_error)?;
    for part in [timestamp, delivery_id, event_type] {
        mac.update(part.as_bytes());
        mac.update(b"\n");
    }
    mac.update(body);
    Ok(format!("sha256={}", hex(&mac.finalize().into_bytes())))
}

// ---- What this PC will do when asked. ----

/// The whole list of what a paired phone can make this PC do.
#[cfg(desktop)]
async fn run_action(request: &Request) -> Response {
    let mut response = Response {
        id: request.id.clone(),
        processes: None,
        error: None,
    };
    match request.action.as_str() {
        ACTION_PROCESSES => match list_processes().await {
            Ok(processes) => response.processes = Some(processes),
            Err(error) => response.error = Some(error.to_string()),
        },
        _ => response.error = Some("this PC does not allow that action".into()),
    }
    response
}

#[cfg(desktop)]
async fn list_processes() -> Result<Vec<Process>> {
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("tasklist");
        command.args(["/fo", "csv", "/nh"]);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new("ps");
        command.args(["-eo", "pid=,comm="]);
        command
    };
    let output = tokio::time::timeout(Duration::from_secs(10), command.kill_on_drop(true).output())
        .await
        .map_err(|_| link_error("listing processes timed out"))?
        .map_err(link_error)?;
    if !output.status.success() {
        return Err(link_error("could not list processes"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    #[cfg(windows)]
    let mut processes = parse_tasklist(&text);
    #[cfg(not(windows))]
    let mut processes = parse_ps(&text);
    processes.sort_by_key(|process| (process.name.to_lowercase(), process.pid));
    Ok(processes)
}

/// `"name.exe","1234","Console","1","12,345 K"` per line.
#[cfg(any(windows, test))]
fn parse_tasklist(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.trim().trim_matches('"').split("\",\"");
            let name = fields.next()?.to_owned();
            let pid = fields.next()?.parse().ok()?;
            Some(Process { pid, name })
        })
        .collect()
}

#[cfg(any(all(desktop, not(windows)), test))]
fn parse_ps(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let (pid, name) = line.trim().split_once(char::is_whitespace)?;
            Some(Process {
                pid: pid.parse().ok()?,
                name: name.trim().to_owned(),
            })
        })
        .collect()
}

// ---- This device's pairings, on disk. ----

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkFile {
    device_id: String,
    devices: Vec<Device>,
}

#[cfg(desktop)]
struct HostPairing {
    code: String,
    expires_at: u64,
    attempts: u8,
}

#[cfg(mobile)]
struct PhonePairing {
    id: String,
    code: String,
    secret: EphemeralSecret,
    public: [u8; 32],
    done: tokio::sync::oneshot::Sender<Device>,
}

#[derive(Default)]
pub struct Link {
    file: Mutex<()>,
    #[cfg(desktop)]
    hosting: Mutex<Option<HostPairing>>,
    #[cfg(desktop)]
    seen: Mutex<HashMap<String, u64>>,
    #[cfg(mobile)]
    pairing: Mutex<Option<PhonePairing>>,
    #[cfg(mobile)]
    waiting: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Response>>>,
}

/// On Android the app's files go to the user's cloud backup by default; a
/// pairing key must not. `no_backup` is the one directory the OS excludes.
#[cfg(any(target_os = "android", test))]
fn no_backup_dir(data_dir: &std::path::Path, identifier: &str) -> Option<PathBuf> {
    data_dir
        .ancestors()
        .find(|path| path.file_name().is_some_and(|name| name == identifier))
        .map(|root| root.join("no_backup"))
}

/// A directory only this app reads and, on Android, kept out of backups: for
/// secrets that must never leave this device.
pub(crate) fn private_dir(app: &AppHandle, name: &str) -> Result<PathBuf> {
    let data = app.path().app_data_dir().map_err(link_error)?;
    #[cfg(target_os = "android")]
    let data = no_backup_dir(&data, &app.config().identifier)
        .ok_or_else(|| link_error("could not find a private directory for secrets"))?;
    let dir = data.join(name);
    fs::create_dir_all(&dir).map_err(link_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(link_error)?;
    }
    Ok(dir)
}

fn store_dir(app: &AppHandle) -> Result<PathBuf> {
    private_dir(app, "link")
}

/// A damaged file is an error rather than empty, so it is never overwritten.
fn load(app: &AppHandle) -> Result<LinkFile> {
    match fs::read(store_dir(app)?.join(FILE)) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(link_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LinkFile::default()),
        Err(error) => Err(link_error(error)),
    }
}

/// Reads, changes and writes under one lock, giving this device its id the
/// first time.
fn update(app: &AppHandle, change: impl FnOnce(&mut LinkFile)) -> Result<LinkFile> {
    let state = app.state::<Link>();
    let _guard = state.file.lock().unwrap();
    let mut file = load(app)?;
    if file.device_id.is_empty() {
        file.device_id = random_id();
    }
    change(&mut file);
    let raw = serde_json::to_vec_pretty(&file).map_err(link_error)?;
    crate::vault::write_atomically(&store_dir(app)?.join(FILE), &raw).map_err(link_error)?;
    Ok(file)
}

fn remember(app: &AppHandle, device: Device) -> Result<()> {
    update(app, |file| {
        file.devices.retain(|known| known.id != device.id);
        file.devices.push(device);
    })
    .map(|_| ())
}

/// Whether this installation needs the Nexus stream for the link. A device
/// that never paired does not listen at all.
pub fn wanted(app: &AppHandle) -> bool {
    if !modules::is_enabled(app, MODULE) {
        return false;
    }
    let state = app.state::<Link>();
    #[cfg(desktop)]
    let pairing = state.hosting.lock().unwrap().is_some();
    #[cfg(mobile)]
    let pairing = state.pairing.lock().unwrap().is_some();
    pairing || load(app).is_ok_and(|file| !file.devices.is_empty())
}

// ---- The channel through Nexus. ----

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    endpoint_id: String,
    signing_secret: String,
}

/// The account's channel. Possession only lets a sender put mail in the inbox;
/// anything unsealed or unknown is dropped by the receiver.
async fn channel(app: &AppHandle, create: bool) -> Result<Channel> {
    let nexus = nexus_auth::signed_in_client(app)?;
    let connections = nexus.connections();
    let credentials = connections
        .granted()
        .await
        .map_err(nexus_auth::nexus_error)?;
    if let Some(existing) = credentials.iter().find(|credential| {
        credential.revoked_at.is_none()
            && credential.namespace == NAMESPACE
            && credential.credential_type == CREDENTIAL_TYPE
    }) {
        let secret = connections
            .read_secret(&existing.id)
            .await
            .map_err(nexus_auth::nexus_error)?;
        return serde_json::from_str(&secret.secret).map_err(link_error);
    }
    if !create {
        return Err(link_error("start pairing in Relay on your PC first"));
    }
    let endpoint = nexus
        .event_endpoints()
        .create(&EventEndpointInput::default())
        .await
        .map_err(nexus_auth::nexus_error)?;
    let created = Channel {
        endpoint_id: endpoint.endpoint_id,
        signing_secret: endpoint.signing_secret,
    };
    connections
        .create(&CredentialInput {
            namespace: NAMESPACE.into(),
            credential_type: CREDENTIAL_TYPE.into(),
            label: "Relay phone link".into(),
            metadata: serde_json::json!({}),
            secret: serde_json::to_string(&created).map_err(link_error)?,
            expires_at: None,
        })
        .await
        .map_err(nexus_auth::nexus_error)?;
    Ok(created)
}

async fn post(app: &AppHandle, event_type: &str, body: &impl Serialize) -> Result<()> {
    let nexus = nexus_auth::signed_in_client(app)?;
    let channel = channel(app, false).await?;
    let body = serde_json::to_vec(body).map_err(link_error)?;
    let timestamp = now_secs().to_string();
    let delivery_id = random_id();
    let key = URL_SAFE_NO_PAD
        .decode(&channel.signing_secret)
        .map_err(link_error)?;
    let signature = ingress_signature(&key, &timestamp, &delivery_id, event_type, &body)?;
    let url = format!(
        "{}/events/ingress/{}",
        nexus.config().issuer.trim_end_matches('/'),
        channel.endpoint_id
    );
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(link_error)?
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Nexus-Timestamp", timestamp)
        .header("X-Nexus-Delivery-Id", delivery_id)
        .header("X-Nexus-Event", event_type)
        .header("X-Nexus-Signature", signature)
        .body(body)
        .send()
        .await
        .map_err(link_error)?
        .error_for_status()
        .map_err(link_error)?;
    Ok(())
}

// ---- Incoming mail. ----

/// Takes the events that belong to the link; `false` leaves it to the caller.
/// A bad message is only logged: it must not hold up the inbox behind it.
pub async fn handle(app: &AppHandle, event: &InboxEvent) -> bool {
    if !event.event_type.starts_with(EVENT_PREFIX) {
        return false;
    }
    if modules::is_enabled(app, MODULE) {
        if let Err(error) = receive(app, event).await {
            log::warn!("phone link: ignored {}: {error}", event.event_type);
        }
    }
    true
}

async fn receive(app: &AppHandle, event: &InboxEvent) -> Result<()> {
    fn parse<T: serde::de::DeserializeOwned>(event: &InboxEvent) -> Result<T> {
        serde_json::from_value(event.payload.clone()).map_err(link_error)
    }
    match event.event_type.as_str() {
        EVENT_SEALED => on_sealed(app, parse(event)?).await,
        #[cfg(desktop)]
        EVENT_PAIR_REQUEST => on_pair_request(app, parse(event)?).await,
        #[cfg(mobile)]
        EVENT_PAIR_RESPONSE => on_pair_response(app, parse(event)?),
        _ => Ok(()),
    }
}

/// Pairing is never accepted while no code is showing on this PC.
#[cfg(desktop)]
async fn on_pair_request(app: &AppHandle, request: PairRequest) -> Result<()> {
    let code = {
        let state = app.state::<Link>();
        let mut hosting = state.hosting.lock().unwrap();
        let Some(pairing) = hosting.as_ref() else {
            return Ok(());
        };
        if pairing.expires_at < now_secs() {
            *hosting = None;
            return Ok(());
        }
        pairing.code.clone()
    };
    let identity = update(app, |_| ())?.device_id;
    let accepted = accept_pair_request(&code, &request, &identity, &computer_name());
    {
        let state = app.state::<Link>();
        let mut hosting = state.hosting.lock().unwrap();
        // Called off while this was being checked, or already used.
        if hosting.as_ref().is_none_or(|p| p.code != code) {
            return Ok(());
        }
        if accepted.is_some() {
            *hosting = None;
        } else if let Some(pairing) = hosting.as_mut() {
            pairing.attempts += 1;
            if pairing.attempts >= PAIRING_ATTEMPTS {
                *hosting = None;
            }
        }
    }
    let Some((device, response)) = accepted else {
        return Err(link_error("a pairing request had the wrong code"));
    };
    remember(app, device)?;
    post(app, EVENT_PAIR_RESPONSE, &response).await
}

#[cfg(mobile)]
fn on_pair_response(app: &AppHandle, response: PairResponse) -> Result<()> {
    let state = app.state::<Link>();
    let mut slot = state.pairing.lock().unwrap();
    if !slot.as_ref().is_some_and(|p| p.id == response.request_id) {
        return Ok(());
    }
    let pairing = slot.take().expect("checked above");
    let device = finish_pairing(
        &pairing.code,
        pairing.secret,
        &pairing.public,
        &pairing.id,
        &response,
    )
    .ok_or_else(|| link_error("a pairing answer failed verification"))?;
    let _ = pairing.done.send(device);
    Ok(())
}

async fn on_sealed(app: &AppHandle, envelope: Envelope) -> Result<()> {
    let file = load(app)?;
    if envelope.to != file.device_id {
        return Ok(());
    }
    let Some(device) = file.devices.iter().find(|d| d.id == envelope.from) else {
        return Ok(());
    };
    let plain = open(&device.key()?, &envelope)
        .ok_or_else(|| link_error("a message failed verification"))?;
    answer(app, &file.device_id, device, &plain).await
}

/// Reached only by a message sealed with this device's key.
#[cfg(desktop)]
async fn answer(app: &AppHandle, own_id: &str, device: &Device, plain: &[u8]) -> Result<()> {
    let request: Request = serde_json::from_slice(plain).map_err(link_error)?;
    let admission = {
        let state = app.state::<Link>();
        let mut seen = state.seen.lock().unwrap();
        admit(&mut seen, &request, now_secs())
    };
    let response = match admission {
        Admission::Replayed => return Ok(()),
        Admission::Expired => Response {
            id: request.id.clone(),
            processes: None,
            error: Some("the request expired; check that both clocks are right".into()),
        },
        Admission::Fresh => run_action(&request).await,
    };
    let plain = serde_json::to_vec(&response).map_err(link_error)?;
    let sealed = seal(&device.key()?, own_id, &device.id, &plain)?;
    post(app, EVENT_SEALED, &sealed).await
}

#[cfg(mobile)]
async fn answer(app: &AppHandle, _own_id: &str, _device: &Device, plain: &[u8]) -> Result<()> {
    let response: Response = serde_json::from_slice(plain).map_err(link_error)?;
    let waiter = app
        .state::<Link>()
        .waiting
        .lock()
        .unwrap()
        .remove(&response.id);
    if let Some(waiter) = waiter {
        let _ = waiter.send(response);
    }
    Ok(())
}

// ---- The interface. ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    id: String,
    name: String,
    paired_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    code: String,
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// `pc` shows codes and answers; `phone` types codes and asks.
    role: &'static str,
    devices: Vec<PairedDevice>,
    pairing: Option<Pairing>,
}

fn status_of(app: &AppHandle) -> Result<LinkStatus> {
    let devices = load(app)?
        .devices
        .into_iter()
        .map(|device| PairedDevice {
            id: device.id,
            name: device.name,
            paired_at: device.paired_at,
        })
        .collect();
    #[cfg(desktop)]
    let (role, pairing) = {
        let now = now_secs();
        let state = app.state::<Link>();
        let hosting = state.hosting.lock().unwrap();
        let pairing = hosting
            .as_ref()
            .filter(|pairing| pairing.expires_at >= now)
            .map(|pairing| Pairing {
                code: pairing.code.clone(),
                expires_at: pairing.expires_at,
            });
        ("pc", pairing)
    };
    #[cfg(mobile)]
    let (role, pairing) = ("phone", None);
    Ok(LinkStatus {
        role,
        devices,
        pairing,
    })
}

#[tauri::command]
pub fn link_status(app: AppHandle) -> Result<LinkStatus> {
    status_of(&app)
}

/// Forgetting deletes this side's key, so the other side's messages stop
/// opening: on a PC that is what revokes a phone.
#[tauri::command]
pub fn link_forget(app: AppHandle, id: String) -> Result<LinkStatus> {
    update(&app, |file| file.devices.retain(|device| device.id != id))?;
    nexus_auth::refresh_events(&app);
    status_of(&app)
}

#[cfg(desktop)]
fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.is_empty() && name.chars().count() <= 64)
        .unwrap_or_else(|| "PC".to_owned())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn link_pair_start(app: AppHandle) -> Result<LinkStatus> {
    channel(&app, true).await?;
    update(&app, |_| ())?;
    *app.state::<Link>().hosting.lock().unwrap() = Some(HostPairing {
        code: new_code(),
        expires_at: now_secs() + PAIRING_TTL_SECS,
        attempts: 0,
    });
    nexus_auth::refresh_events(&app);
    status_of(&app)
}

#[cfg(desktop)]
#[tauri::command]
pub fn link_pair_cancel(app: AppHandle) -> Result<LinkStatus> {
    *app.state::<Link>().hosting.lock().unwrap() = None;
    nexus_auth::refresh_events(&app);
    status_of(&app)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn link_pair(app: AppHandle, code: String) -> Result<LinkStatus> {
    let code = normalize_code(&code);
    let device_id = update(&app, |_| ())?.device_id;
    let (request, secret, public) = new_pair_request(&code, &device_id, "Android phone");
    let (done, finished) = tokio::sync::oneshot::channel();
    *app.state::<Link>().pairing.lock().unwrap() = Some(PhonePairing {
        id: request.id.clone(),
        code,
        secret,
        public,
        done,
    });
    nexus_auth::refresh_events(&app);
    let result = async {
        post(&app, EVENT_PAIR_REQUEST, &request).await?;
        tokio::time::timeout(ANSWER_TIMEOUT, finished)
            .await
            .map_err(|_| {
                link_error("no answer: check the code and that Relay is running on your PC")
            })?
            .map_err(|_| link_error("the answer did not verify; start pairing again"))
    }
    .await;
    *app.state::<Link>().pairing.lock().unwrap() = None;
    let outcome = result.and_then(|device| remember(&app, device));
    nexus_auth::refresh_events(&app);
    outcome?;
    status_of(&app)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn link_processes(app: AppHandle, device_id: String) -> Result<Vec<Process>> {
    let file = load(&app)?;
    let device = file
        .devices
        .iter()
        .find(|device| device.id == device_id)
        .ok_or_else(|| link_error("this PC is not paired"))?;
    let request = Request {
        id: random_id(),
        expires_at: now_secs() + REQUEST_TTL_SECS,
        action: ACTION_PROCESSES.to_owned(),
    };
    let plain = serde_json::to_vec(&request).map_err(link_error)?;
    let sealed = seal(&device.key()?, &file.device_id, &device.id, &plain)?;
    let (answered, answer) = tokio::sync::oneshot::channel();
    let state = app.state::<Link>();
    state
        .waiting
        .lock()
        .unwrap()
        .insert(request.id.clone(), answered);
    let sent = post(&app, EVENT_SEALED, &sealed).await;
    let answer = match sent {
        Ok(()) => tokio::time::timeout(ANSWER_TIMEOUT, answer).await.ok(),
        Err(_) => None,
    };
    state.waiting.lock().unwrap().remove(&request.id);
    sent?;
    let response = answer
        .and_then(|answer| answer.ok())
        .ok_or_else(|| link_error("your PC did not answer; is Relay running there?"))?;
    match response.error {
        Some(error) => Err(link_error(error)),
        None => Ok(response.processes.unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired() -> (Device, Device) {
        let code = new_code();
        let (request, secret, public) = new_pair_request(&code, "phone-id", "Phone");
        let (at_pc, response) = accept_pair_request(&code, &request, "pc-id", "PC").unwrap();
        let at_phone = finish_pairing(&code, secret, &public, &request.id, &response).unwrap();
        (at_pc, at_phone)
    }

    #[test]
    fn pairing_gives_both_devices_the_same_key_and_each_others_names() {
        let (at_pc, at_phone) = paired();
        assert_eq!(at_pc.key().unwrap(), at_phone.key().unwrap());
        assert_eq!(
            (at_pc.id.as_str(), at_pc.name.as_str()),
            ("phone-id", "Phone")
        );
        assert_eq!(
            (at_phone.id.as_str(), at_phone.name.as_str()),
            ("pc-id", "PC")
        );
    }

    #[test]
    fn a_pc_refuses_a_phone_without_the_code() {
        let (request, _, _) = new_pair_request("WRONGCODE0", "phone-id", "Phone");
        assert!(accept_pair_request("RIGHTCODE0", &request, "pc-id", "PC").is_none());
    }

    /// The attack this whole design exists for: Nexus swaps in its own key.
    #[test]
    fn nexus_cannot_get_in_the_middle_of_pairing() {
        let code = new_code();
        let attacker = PublicKey::from(&EphemeralSecret::random_from_rng(OsRng)).to_bytes();

        let (mut request, _, _) = new_pair_request(&code, "phone-id", "Phone");
        request.public_key = BASE64.encode(attacker);
        assert!(accept_pair_request(&code, &request, "pc-id", "PC").is_none());

        let (request, secret, public) = new_pair_request(&code, "phone-id", "Phone");
        let (_, mut response) = accept_pair_request(&code, &request, "pc-id", "PC").unwrap();
        response.public_key = BASE64.encode(attacker);
        assert!(finish_pairing(&code, secret, &public, &request.id, &response).is_none());
    }

    #[test]
    fn a_renamed_device_fails_pairing_on_both_sides() {
        let code = new_code();
        let (mut request, _, _) = new_pair_request(&code, "phone-id", "Phone");
        request.name = "Trust me".into();
        assert!(accept_pair_request(&code, &request, "pc-id", "PC").is_none());

        let (request, secret, public) = new_pair_request(&code, "phone-id", "Phone");
        let (_, mut response) = accept_pair_request(&code, &request, "pc-id", "PC").unwrap();
        response.name = "Trust me".into();
        assert!(finish_pairing(&code, secret, &public, &request.id, &response).is_none());
    }

    #[test]
    fn a_low_order_public_key_is_refused() {
        // All zeros is a low-order point: the shared secret would be all zeros
        // whatever the other side's key is.
        let code = new_code();
        let secret = EphemeralSecret::random_from_rng(OsRng);
        assert!(shared_key(secret, [0u8; 32], &code, &[0u8; 32], &[1u8; 32]).is_none());
    }

    #[test]
    fn sealed_messages_only_open_unchanged_with_the_right_key() {
        let (at_pc, at_phone) = paired();
        let key = at_phone.key().unwrap();
        let sealed = seal(&key, "phone-id", "pc-id", b"hello").unwrap();
        assert_eq!(open(&at_pc.key().unwrap(), &sealed).unwrap(), b"hello");

        let other = paired().0.key().unwrap();
        assert!(open(&other, &sealed).is_none(), "another pairing's key");

        let mut tampered = sealed.clone();
        tampered.ciphertext = BASE64.encode(b"forged, with enough bytes for a tag");
        assert!(open(&key, &tampered).is_none(), "changed content");

        let mut reflected = sealed.clone();
        std::mem::swap(&mut reflected.from, &mut reflected.to);
        assert!(open(&key, &reflected).is_none(), "sent back to its sender");
    }

    #[test]
    fn a_request_runs_once_and_only_while_it_is_valid() {
        let request = |id: &str, expires_at| Request {
            id: id.to_owned(),
            expires_at,
            action: ACTION_PROCESSES.to_owned(),
        };
        let mut seen = HashMap::new();
        assert_eq!(
            admit(&mut seen, &request("a", 1_060), 1_000),
            Admission::Fresh
        );
        assert_eq!(
            admit(&mut seen, &request("a", 1_060), 1_001),
            Admission::Replayed
        );
        assert_eq!(
            admit(&mut seen, &request("old", 999), 1_000),
            Admission::Expired
        );
        assert_eq!(
            admit(
                &mut seen,
                &request("far", 1_000 + MAX_REQUEST_AHEAD_SECS + 1),
                1_000
            ),
            Admission::Expired
        );
        // Forgotten once expired, and the expiry still refuses it.
        assert_eq!(
            admit(&mut seen, &request("a", 1_060), 1_061),
            Admission::Expired
        );
        assert!(seen.is_empty());
    }

    #[tokio::test]
    async fn only_the_listed_action_runs() {
        let request = |action: &str| Request {
            id: "id".into(),
            expires_at: now_secs() + 60,
            action: action.to_owned(),
        };
        for refused in ["shell.exec", "", "PROCESSES.LIST", "processes.list "] {
            let response = run_action(&request(refused)).await;
            assert!(response.processes.is_none(), "{refused:?} ran");
            assert!(response.error.is_some());
        }
        let response = run_action(&request(ACTION_PROCESSES)).await;
        assert!(!response.processes.expect("a real process list").is_empty());
    }

    #[test]
    fn process_listings_parse() {
        assert_eq!(
            parse_tasklist(
                "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"a,b.exe\",\"42\",\"Console\",\"1\",\"12,345 K\"\r\nnot a row\r\n"
            ),
            [
                Process {
                    pid: 0,
                    name: "System Idle Process".into()
                },
                Process {
                    pid: 42,
                    name: "a,b.exe".into()
                },
            ]
        );
        assert_eq!(
            parse_ps("  1 systemd\n 42 my app\nbad line\n"),
            [
                Process {
                    pid: 1,
                    name: "systemd".into()
                },
                Process {
                    pid: 42,
                    name: "my app".into()
                },
            ]
        );
    }

    #[test]
    fn a_typed_code_matches_however_it_was_typed() {
        assert_eq!(normalize_code(" ab1o2-il3k4 "), "AB102113K4");
        let code = new_code();
        assert_eq!(code.len(), CODE_LEN);
        assert_eq!(normalize_code(&code), code);
    }

    #[test]
    fn android_keys_stay_out_of_cloud_backup() {
        for data in [
            "/data/user/0/dev.eresea.relay",
            "/data/user/0/dev.eresea.relay/files",
        ] {
            assert_eq!(
                no_backup_dir(std::path::Path::new(data), "dev.eresea.relay").unwrap(),
                std::path::Path::new("/data/user/0/dev.eresea.relay/no_backup")
            );
        }
        assert!(no_backup_dir(std::path::Path::new("/tmp/other"), "dev.eresea.relay").is_none());
    }

    /// Computed independently from Nexus's `validSignature` (Python's hmac over
    /// `timestamp\ndelivery\ntype\nbody`), so a format drift fails here.
    #[test]
    fn ingress_signature_matches_nexus() {
        assert_eq!(
            ingress_signature(
                b"0123456789abcdef",
                "1700000000",
                "d1",
                "relay.link.sealed",
                b"{\"a\":1}"
            )
            .unwrap(),
            "sha256=89e08ee8c53238c51ce2e58e91f72bd836f295ef5b410007192bcad27a8e5440"
        );
    }
}

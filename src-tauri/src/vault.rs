//! The local password vault: generation, encrypted-at-rest storage, and export.
//!
//! Entries only ever exist in plaintext in memory, and only while the vault
//! is unlocked (`VaultState`, managed as Tauri state). On disk they are one
//! AES-256-GCM ciphertext (`vault.json` in the app-data directory), keyed by
//! an Argon2id hash of the user's master password plus a random salt stored
//! alongside the ciphertext. There is no password reset: losing the master
//! password loses the vault, by design — a recovery path would be a second
//! way in.
//!
//! GCM's authentication tag doubles as the "wrong password" check: decrypting
//! with the wrong key fails the tag verification, so `unlock` needs no
//! separate password verifier stored on disk.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::seq::SliceRandom;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

use crate::error::{Error, Result};

const VAULT_FILE: &str = "vault.json";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const MIN_MASTER_PASSWORD_LEN: usize = 8;
const VAULT_FILE_MAGIC: &[u8] = b"RLYENC1\0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub label: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Everything about an entry but the secret itself. Listing entries returns
/// these, not `VaultEntry`, so a rendered list never puts every plaintext
/// password into the DOM at once — a password only crosses IPC when
/// `reveal_password` asks for that one entry by id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntrySummary {
    pub id: String,
    pub label: String,
    pub username: String,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&VaultEntry> for VaultEntrySummary {
    fn from(entry: &VaultEntry) -> Self {
        Self {
            id: entry.id.clone(),
            label: entry.label.clone(),
            username: entry.username.clone(),
            url: entry.url.clone(),
            notes: entry.notes.clone(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewVaultEntry {
    pub label: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordOptions {
    pub length: u8,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
}

/// The on-disk shape. `salt` and `nonce` are not secret — GCM's security
/// depends on the key and on never reusing a nonce with the same key, not on
/// hiding either value — so both are stored right next to the ciphertext
/// they belong to.
#[derive(Debug, Serialize, Deserialize)]
struct VaultFile {
    version: u8,
    salt: String,
    nonce: String,
    ciphertext: String,
}

struct Unlocked {
    key: [u8; KEY_LEN],
    salt: [u8; SALT_LEN],
    entries: Vec<VaultEntry>,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        // The key is the one thing here worth scrubbing on lock/drop; the
        // entries it decrypted are also sensitive but Rust gives no way to
        // guarantee their heap allocations are wiped, so this is best-effort
        // rather than a real secrecy guarantee.
        self.key.zeroize();
    }
}

#[derive(Default)]
pub struct VaultState(Mutex<Option<Unlocked>>);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn file_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(VAULT_FILE))
}

fn read_file(app: &AppHandle) -> Result<Option<VaultFile>> {
    let path = file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let file = serde_json::from_str(&raw).map_err(|e| Error::VaultCorrupt(e.to_string()))?;
    Ok(Some(file))
}

fn write_file(app: &AppHandle, file: &VaultFile) -> Result<()> {
    let path = file_path(app)?;
    let raw = serde_json::to_string_pretty(file).map_err(|e| Error::VaultCorrupt(e.to_string()))?;
    fs::write(path, raw)?;
    Ok(())
}

fn derive_key(master_password: &str, salt: &[u8; SALT_LEN]) -> Result<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|_| Error::Crypto)?;
    Ok(key)
}

fn encrypt_entries(key: &[u8; KEY_LEN], entries: &[VaultEntry]) -> Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = serde_json::to_vec(entries).map_err(|e| Error::VaultCorrupt(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| Error::Crypto)?;
    Ok((BASE64.encode(nonce_bytes), BASE64.encode(ciphertext)))
}

fn decrypt_entries(
    key: &[u8; KEY_LEN],
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> Result<Vec<VaultEntry>> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let nonce_bytes = BASE64
        .decode(nonce_b64)
        .map_err(|_| Error::VaultCorrupt("nonce is not valid base64".into()))?;
    let ciphertext = BASE64
        .decode(ciphertext_b64)
        .map_err(|_| Error::VaultCorrupt("ciphertext is not valid base64".into()))?;
    // A failed decrypt here is, in practice, always a wrong master password —
    // GCM's authentication tag will not verify under any other key.
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| Error::WrongMasterPassword)?;
    serde_json::from_slice(&plaintext).map_err(|e| Error::VaultCorrupt(e.to_string()))
}

fn persist(app: &AppHandle, unlocked: &Unlocked) -> Result<()> {
    // Re-encrypts the whole entry list under a fresh nonce and rewrites the
    // file. Vaults are small (a person's own accounts, not a corpus), so a
    // full rewrite per change is simpler than an append log and never reuses
    // a nonce with the same key — reuse is what actually breaks GCM.
    let (nonce, ciphertext) = encrypt_entries(&unlocked.key, &unlocked.entries)?;
    write_file(
        app,
        &VaultFile {
            version: 1,
            salt: BASE64.encode(unlocked.salt),
            nonce,
            ciphertext,
        },
    )
}

pub fn status(app: &AppHandle, state: &VaultState) -> Result<VaultStatus> {
    Ok(VaultStatus {
        exists: file_path(app)?.exists(),
        unlocked: state.0.lock().unwrap().is_some(),
    })
}

pub fn create(app: &AppHandle, state: &VaultState, master_password: &str) -> Result<()> {
    if file_path(app)?.exists() {
        return Err(Error::VaultAlreadyExists);
    }
    if master_password.len() < MIN_MASTER_PASSWORD_LEN {
        return Err(Error::WeakMasterPassword);
    }

    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(master_password, &salt)?;
    let (nonce, ciphertext) = encrypt_entries(&key, &[])?;
    write_file(
        app,
        &VaultFile {
            version: 1,
            salt: BASE64.encode(salt),
            nonce,
            ciphertext,
        },
    )?;

    *state.0.lock().unwrap() = Some(Unlocked {
        key,
        salt,
        entries: Vec::new(),
    });
    Ok(())
}

pub fn unlock(app: &AppHandle, state: &VaultState, master_password: &str) -> Result<()> {
    let file = read_file(app)?.ok_or(Error::VaultNotFound)?;
    let salt_bytes = BASE64
        .decode(&file.salt)
        .map_err(|_| Error::VaultCorrupt("salt is not valid base64".into()))?;
    let salt: [u8; SALT_LEN] = salt_bytes
        .try_into()
        .map_err(|_| Error::VaultCorrupt("salt has the wrong length".into()))?;

    let key = derive_key(master_password, &salt)?;
    let entries = decrypt_entries(&key, &file.nonce, &file.ciphertext)?;

    *state.0.lock().unwrap() = Some(Unlocked { key, salt, entries });
    Ok(())
}

pub fn lock(state: &VaultState) -> Result<()> {
    *state.0.lock().unwrap() = None;
    Ok(())
}

pub fn ensure_unlocked(state: &VaultState) -> Result<()> {
    if state.0.lock().unwrap().is_some() {
        Ok(())
    } else {
        Err(Error::VaultLocked)
    }
}

pub fn encrypt_file_content(state: &VaultState, content: &[u8]) -> Result<Vec<u8>> {
    let guard = state.0.lock().unwrap();
    let unlocked = guard.as_ref().ok_or(Error::VaultLocked)?;
    let cipher = Aes256Gcm::new_from_slice(&unlocked.key).map_err(|_| Error::Crypto)?;
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), content)
        .map_err(|_| Error::Crypto)?;
    let mut encrypted = Vec::with_capacity(VAULT_FILE_MAGIC.len() + NONCE_LEN + ciphertext.len());
    encrypted.extend_from_slice(VAULT_FILE_MAGIC);
    encrypted.extend_from_slice(&nonce);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

pub fn decrypt_file_content(state: &VaultState, content: &[u8]) -> Result<Vec<u8>> {
    let guard = state.0.lock().unwrap();
    let unlocked = guard.as_ref().ok_or(Error::VaultLocked)?;
    if !content.starts_with(VAULT_FILE_MAGIC) {
        return Ok(content.to_vec());
    }
    let start = VAULT_FILE_MAGIC.len();
    let nonce_end = start + NONCE_LEN;
    let nonce = content
        .get(start..nonce_end)
        .ok_or_else(|| Error::VaultCorrupt("encrypted file header is incomplete".into()))?;
    let ciphertext = content
        .get(nonce_end..)
        .ok_or_else(|| Error::VaultCorrupt("encrypted file data is incomplete".into()))?;
    let cipher = Aes256Gcm::new_from_slice(&unlocked.key).map_err(|_| Error::Crypto)?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| Error::Crypto)
}

pub fn add_entry(
    app: &AppHandle,
    state: &VaultState,
    new_entry: NewVaultEntry,
) -> Result<VaultEntrySummary> {
    let mut guard = state.0.lock().unwrap();
    let unlocked = guard.as_mut().ok_or(Error::VaultLocked)?;

    let mut id_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut id_bytes);
    let now = now_millis();
    let entry = VaultEntry {
        id: BASE64.encode(id_bytes),
        label: new_entry.label,
        username: new_entry.username,
        password: new_entry.password,
        url: new_entry.url,
        notes: new_entry.notes,
        created_at: now,
        updated_at: now,
    };
    let summary = VaultEntrySummary::from(&entry);
    unlocked.entries.push(entry);
    persist(app, unlocked)?;
    Ok(summary)
}

pub fn list_entries(state: &VaultState) -> Result<Vec<VaultEntrySummary>> {
    let guard = state.0.lock().unwrap();
    let unlocked = guard.as_ref().ok_or(Error::VaultLocked)?;
    Ok(unlocked
        .entries
        .iter()
        .map(VaultEntrySummary::from)
        .collect())
}

pub fn reveal_password(state: &VaultState, id: &str) -> Result<String> {
    let guard = state.0.lock().unwrap();
    let unlocked = guard.as_ref().ok_or(Error::VaultLocked)?;
    unlocked
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.password.clone())
        .ok_or_else(|| Error::UnknownVaultEntry(id.to_string()))
}

pub fn delete_entry(app: &AppHandle, state: &VaultState, id: &str) -> Result<()> {
    let mut guard = state.0.lock().unwrap();
    let unlocked = guard.as_mut().ok_or(Error::VaultLocked)?;

    let before = unlocked.entries.len();
    unlocked.entries.retain(|entry| entry.id != id);
    if unlocked.entries.len() == before {
        return Err(Error::UnknownVaultEntry(id.to_string()));
    }
    persist(app, unlocked)
}

/// Writes a standalone, still-encrypted copy of the vault to the user's
/// documents folder and returns the path. The export is a full `VaultFile`,
/// not a plaintext dump — a portable backup is only worth having if losing
/// it does not also lose every password inside it.
pub fn export(app: &AppHandle, state: &VaultState) -> Result<String> {
    let guard = state.0.lock().unwrap();
    let unlocked = guard.as_ref().ok_or(Error::VaultLocked)?;

    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())?;
    fs::create_dir_all(&dir)?;

    let (nonce, ciphertext) = encrypt_entries(&unlocked.key, &unlocked.entries)?;
    let file = VaultFile {
        version: 1,
        salt: BASE64.encode(unlocked.salt),
        nonce,
        ciphertext,
    };
    let path = dir.join(format!("relay-vault-export-{}.json", now_millis()));
    let raw =
        serde_json::to_string_pretty(&file).map_err(|e| Error::VaultCorrupt(e.to_string()))?;
    fs::write(&path, raw)?;
    Ok(path.display().to_string())
}

/// Characters that are easy to confuse at a glance (`0`/`O`, `1`/`l`/`I`) are
/// left out of every pool — a generated password is meant to be typed
/// correctly on the first try at least as often as it is pasted.
const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
const DIGITS: &[u8] = b"23456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{}";

pub fn generate_password(options: &PasswordOptions) -> Result<String> {
    let mut pools: Vec<&[u8]> = Vec::new();
    if options.upper {
        pools.push(UPPER);
    }
    if options.lower {
        pools.push(LOWER);
    }
    if options.digits {
        pools.push(DIGITS);
    }
    if options.symbols {
        pools.push(SYMBOLS);
    }
    if pools.is_empty() {
        return Err(Error::InvalidPasswordOptions);
    }

    let length = (options.length as usize).clamp(pools.len().max(4), 128);
    let mut rng = rand::thread_rng();
    let all: Vec<u8> = pools.iter().flat_map(|pool| pool.iter().copied()).collect();

    // Guarantee at least one character from every selected class, then fill
    // the rest from the combined pool, so "letters + symbols" cannot come
    // back as an all-letters password by chance.
    let mut chars: Vec<u8> = pools
        .iter()
        .map(|pool| pool[rng.gen_range(0..pool.len())])
        .collect();
    while chars.len() < length {
        chars.push(all[rng.gen_range(0..all.len())]);
    }
    chars.shuffle(&mut rng);

    Ok(String::from_utf8(chars).expect("character pools are ASCII"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_password_has_the_requested_length_and_classes() {
        let password = generate_password(&PasswordOptions {
            length: 20,
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
        })
        .unwrap();

        assert_eq!(password.len(), 20);
        assert!(password.bytes().any(|b| UPPER.contains(&b)));
        assert!(password.bytes().any(|b| LOWER.contains(&b)));
        assert!(password.bytes().any(|b| DIGITS.contains(&b)));
        assert!(password.bytes().any(|b| SYMBOLS.contains(&b)));
    }

    #[test]
    fn no_selected_classes_is_rejected() {
        let result = generate_password(&PasswordOptions {
            length: 16,
            upper: false,
            lower: false,
            digits: false,
            symbols: false,
        });
        assert!(matches!(result, Err(Error::InvalidPasswordOptions)));
    }

    #[test]
    fn generated_passwords_never_contain_ambiguous_characters() {
        for _ in 0..50 {
            let password = generate_password(&PasswordOptions {
                length: 32,
                upper: true,
                lower: true,
                digits: true,
                symbols: false,
            })
            .unwrap();
            assert!(!password.contains(['0', 'O', '1', 'l', 'I']));
        }
    }

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let key = [7u8; KEY_LEN];
        let entries = vec![VaultEntry {
            id: "a".into(),
            label: "Example".into(),
            username: "me@example.com".into(),
            password: "hunter2".into(),
            url: None,
            notes: None,
            created_at: 0,
            updated_at: 0,
        }];

        let (nonce, ciphertext) = encrypt_entries(&key, &entries).unwrap();
        let decrypted = decrypt_entries(&key, &nonce, &ciphertext).unwrap();
        assert_eq!(decrypted.len(), 1);
        assert_eq!(decrypted[0].password, "hunter2");
    }

    #[test]
    fn decrypting_with_the_wrong_key_fails_closed() {
        let entries = vec![VaultEntry {
            id: "a".into(),
            label: "Example".into(),
            username: "me@example.com".into(),
            password: "hunter2".into(),
            url: None,
            notes: None,
            created_at: 0,
            updated_at: 0,
        }];
        let (nonce, ciphertext) = encrypt_entries(&[1u8; KEY_LEN], &entries).unwrap();
        let result = decrypt_entries(&[2u8; KEY_LEN], &nonce, &ciphertext);
        assert!(matches!(result, Err(Error::WrongMasterPassword)));
    }

    #[test]
    fn same_key_never_reuses_a_nonce() {
        let key = [3u8; KEY_LEN];
        let (nonce_a, _) = encrypt_entries(&key, &[]).unwrap();
        let (nonce_b, _) = encrypt_entries(&key, &[]).unwrap();
        assert_ne!(nonce_a, nonce_b);
    }
}

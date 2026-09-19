//! Where the Gmail OAuth refresh token's encryption key lives.
//!
//! The password vault (`vault.rs`) derives its key from a master password the
//! user types on every unlock. That is the wrong shape here: the whole point
//! of a mail connector is background notifications with no window open, so
//! there is nothing to prompt for on launch. Instead the 32-byte data
//! encryption key is generated once and handed to the OS's own secret store
//! — Keychain on macOS, Credential Manager on Windows, Secret Service
//! (libsecret) on Linux, all via the `keyring` crate — and only that key
//! touches it. The refresh token itself stays out of settings.json in
//! plaintext: it is AES-256-GCM ciphertext next to the rest of the
//! connector's config (`gmail.json`), the same cipher construction
//! `vault.rs` uses for entries, just keyed from an OS-backed secret instead
//! of a password.
//!
//! `KeyStore` is a trait, not a direct `keyring` call, for the same reason
//! `EventSink` exists: tests need to run with no keychain daemon available at
//! all (true of most CI containers), so they exercise a `FakeKeyStore`
//! instead.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const KEYRING_SERVICE: &str = "dev.relay.gmail";
const KEYRING_USER: &str = "refresh-token-key";

pub trait KeyStore: Send + Sync {
    /// Returns the existing key, or generates and persists a new one if none
    /// exists yet.
    fn get_or_create_key(&self) -> Result<[u8; KEY_LEN]>;
    /// Removes the key. Called on disconnect so a stale key cannot decrypt a
    /// refresh token belonging to a since-replaced connection.
    fn delete_key(&self) -> Result<()>;
}

pub struct OsKeyStore;

impl KeyStore for OsKeyStore {
    fn get_or_create_key(&self) -> Result<[u8; KEY_LEN]> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| Error::SecretStoreUnavailable(e.to_string()))?;
        match entry.get_password() {
            Ok(encoded) => decode_key(&encoded),
            Err(keyring::Error::NoEntry) => {
                let mut key = [0u8; KEY_LEN];
                OsRng.fill_bytes(&mut key);
                entry
                    .set_password(&BASE64.encode(key))
                    .map_err(|e| Error::SecretStoreUnavailable(e.to_string()))?;
                Ok(key)
            }
            Err(e) => Err(Error::SecretStoreUnavailable(e.to_string())),
        }
    }

    fn delete_key(&self) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| Error::SecretStoreUnavailable(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::SecretStoreUnavailable(e.to_string())),
        }
    }
}

fn decode_key(encoded: &str) -> Result<[u8; KEY_LEN]> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| Error::SecretStoreUnavailable("stored key is not valid base64".into()))?;
    bytes
        .try_into()
        .map_err(|_| Error::SecretStoreUnavailable("stored key has the wrong length".into()))
}

/// The on-disk shape of an encrypted secret. `nonce` is not itself secret —
/// GCM's security depends on the key and on never reusing a nonce with the
/// same key, not on hiding either value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedSecret {
    pub nonce: String,
    pub ciphertext: String,
}

pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &str) -> Result<EncryptedSecret> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| Error::Crypto)?;
    Ok(EncryptedSecret {
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

pub fn decrypt(key: &[u8; KEY_LEN], secret: &EncryptedSecret) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::Crypto)?;
    let nonce_bytes = BASE64
        .decode(&secret.nonce)
        .map_err(|_| Error::GmailCorrupt("nonce is not valid base64".into()))?;
    let ciphertext = BASE64
        .decode(&secret.ciphertext)
        .map_err(|_| Error::GmailCorrupt("ciphertext is not valid base64".into()))?;
    // A failed decrypt here means the OS keychain returned a key that no
    // longer matches this ciphertext — GCM's authentication tag will not
    // verify under any other key.
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| Error::Crypto)?;
    String::from_utf8(plaintext)
        .map_err(|_| Error::GmailCorrupt("decrypted secret is not valid UTF-8".into()))
}

#[cfg(test)]
pub(crate) struct FakeKeyStore(std::sync::Mutex<Option<[u8; KEY_LEN]>>);

#[cfg(test)]
impl Default for FakeKeyStore {
    fn default() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

#[cfg(test)]
impl KeyStore for FakeKeyStore {
    fn get_or_create_key(&self) -> Result<[u8; KEY_LEN]> {
        let mut guard = self.0.lock().unwrap();
        if let Some(key) = *guard {
            return Ok(key);
        }
        let mut key = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut key);
        *guard = Some(key);
        Ok(key)
    }

    fn delete_key(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let key = [7u8; KEY_LEN];
        let secret = encrypt(&key, "refresh-token-value").unwrap();
        assert_eq!(decrypt(&key, &secret).unwrap(), "refresh-token-value");
    }

    #[test]
    fn decrypting_with_the_wrong_key_fails_closed() {
        let secret = encrypt(&[1u8; KEY_LEN], "refresh-token-value").unwrap();
        assert!(matches!(
            decrypt(&[2u8; KEY_LEN], &secret),
            Err(Error::Crypto)
        ));
    }

    #[test]
    fn same_key_never_reuses_a_nonce() {
        let key = [3u8; KEY_LEN];
        let a = encrypt(&key, "x").unwrap();
        let b = encrypt(&key, "x").unwrap();
        assert_ne!(a.nonce, b.nonce);
    }

    #[test]
    fn fake_key_store_persists_the_same_key_across_calls() {
        let store = FakeKeyStore::default();
        let first = store.get_or_create_key().unwrap();
        let second = store.get_or_create_key().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn deleting_the_key_makes_the_next_call_generate_a_fresh_one() {
        let store = FakeKeyStore::default();
        let first = store.get_or_create_key().unwrap();
        store.delete_key().unwrap();
        let second = store.get_or_create_key().unwrap();
        assert_ne!(first, second);
    }
}
